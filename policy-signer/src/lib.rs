//! ShareExact policy signer (C1).
//!
//! An AI agent asks this contract to move Stock Tokens on Robinhood Chain. The
//! agent holds no EVM key. This contract owns a Chain Signatures-derived EVM
//! address, builds the exact transaction itself, checks it against the owner's
//! policy and the share unit, and only then asks the NEAR MPC network for a
//! signature. The signed payload is exactly the payload the policy checked.
//!
//! Roles, all separate accounts:
//! - owner: sets policy. Never this contract's own account.
//! - agent: may call `request` and nothing else that changes state.
//! - signer: the MPC contract (`v1.signer-prod.testnet` / `v1.signer`).
//!
//! Never delete this account. The derived EVM address depends only on the
//! account id and the path, so whoever re-creates the name controls it.

pub mod evm;
pub mod math;
pub mod policy;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

use evm::{Address, TxFields};
use policy::{
    evaluate, record_of, Approved, ChainPolicy, Context, Fees, Params, Refusal, SignedRecord,
    TokenPolicy, TransferRequest, MIN_CORP_ACTION_WINDOW_S,
};

/// Robinhood Chain mainnet. Never allowlisted on a contract deployed to a
/// `.testnet` account: the testnet MPC key must not sign mainnet payloads.
pub const MAINNET_CHAIN_IDS: [u64; 1] = [4663];
const SIGN_DEPOSIT_YOCTO: u128 = 1;
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const MIN_SIGN_GAS_TGAS: u64 = 15;
const SECONDS_PER_DAY: u64 = 86_400;
const EVENT_STANDARD: &str = "shareexact-policy-signer";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct DaySpend {
    pub day: u64,
    pub spent: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct NonceState {
    /// Next fresh nonce C1 will sign on this chain.
    pub next: u64,
    pub last_signed: Option<SignedRecord>,
    /// A request waiting on the MPC signer.
    pub in_flight: Option<InFlight>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct InFlight {
    pub request_id: u64,
    pub nonce: u64,
    pub token: String,
    /// Raw reserved against today's cap, released if signing fails.
    pub reserved_raw: U128,
    pub day: u64,
    pub is_replacement: bool,
    pub record: SignedRecord,
    /// Hex of the EIP-1559 signing payload, returned with the signature.
    pub unsigned_tx: String,
    pub sighash: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "status")]
pub enum Outcome {
    /// Policy passed; the MPC signer was asked. The signature arrives in the
    /// callback's return value and in a `signed` event.
    #[serde(rename = "SIGNING")]
    Signing { request_id: u64 },
    #[serde(rename = "REFUSED")]
    Refused { reason: Refusal },
    #[serde(rename = "SIGNED")]
    Signed {
        request_id: u64,
        chain_id: u64,
        nonce: u64,
        unsigned_tx: String,
        sighash: String,
        signature: Value,
    },
    #[serde(rename = "SIGN_FAILED")]
    SignFailed { request_id: u64, error: String },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Preview {
    pub accepted: bool,
    pub refusal: Option<Refusal>,
    pub raw: Option<U128>,
    pub delivered_shares: Option<U128>,
    pub to: Option<String>,
    pub calldata: Option<String>,
    pub unsigned_tx: Option<String>,
    pub sighash: Option<String>,
    pub is_replacement: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub agent: AccountId,
    pub signer: AccountId,
    pub path: String,
    pub sign_gas_tgas: u64,
    pub params: Params,
    pub requests_today: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolicySigner {
    owner: AccountId,
    agent: AccountId,
    signer: AccountId,
    path: String,
    sign_gas_tgas: u64,
    params: Params,
    chains: LookupMap<u64, ChainPolicy>,
    tokens: LookupMap<(u64, Address), TokenPolicy>,
    recipients: LookupMap<(u64, Address), bool>,
    spend: LookupMap<(u64, Address), DaySpend>,
    nonces: LookupMap<u64, NonceState>,
    request_day: u64,
    requests_today: u32,
    next_request_id: u64,
}

#[near]
impl PolicySigner {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, signer: AccountId, path: String) -> Self {
        let me = env::current_account_id();
        require!(owner != me, "owner must be a separate account");
        require!(agent != me, "agent must be a separate account");
        require!(agent != owner, "agent and owner must differ");
        require!(!path.is_empty(), "path must not be empty");
        Self {
            owner,
            agent,
            signer,
            path,
            sign_gas_tgas: 50,
            params: Params::default(),
            chains: LookupMap::new(b"c"),
            tokens: LookupMap::new(b"t"),
            recipients: LookupMap::new(b"r"),
            spend: LookupMap::new(b"s"),
            nonces: LookupMap::new(b"n"),
            request_day: 0,
            requests_today: 0,
            next_request_id: 1,
        }
    }

    /* ------------------------------ agent ------------------------------ */

    /// The agent's only state-changing method. Refusals are returned (and
    /// logged as events), not panicked, so the reason is on chain.
    pub fn request(&mut self, request: TransferRequest) -> PromiseOrValue<Outcome> {
        require!(
            env::predecessor_account_id() == self.agent,
            "only the agent may request"
        );
        let now_s = now_s();
        self.roll_day(now_s);

        let token = evm::parse_address(&request.token).ok();
        let recipient = evm::parse_address(&request.recipient).ok();
        let decision = {
            let ctx = self.context(request.chain_id, token, recipient, now_s);
            evaluate(&request, &ctx)
        };
        match decision {
            Err(reason) => {
                emit(
                    "refused",
                    json!({
                        "chain_id": request.chain_id,
                        "token": request.token,
                        "recipient": request.recipient,
                        "reason": reason,
                        "ui_shares": request.ui_shares,
                    }),
                );
                PromiseOrValue::Value(Outcome::Refused { reason })
            }
            Ok(approved) => PromiseOrValue::Promise(self.reserve_and_sign(
                request.chain_id,
                token.expect("checked by evaluate"),
                approved,
                now_s,
            )),
        }
    }

    /// Exactly what `request` would decide right now, without reserving or signing.
    pub fn preview(&self, request: TransferRequest) -> Preview {
        let now_s = now_s();
        let token = evm::parse_address(&request.token).ok();
        let recipient = evm::parse_address(&request.recipient).ok();
        let mut ctx = self.context(request.chain_id, token, recipient, now_s);
        if self.request_day != now_s / SECONDS_PER_DAY {
            ctx.requests_today = 0;
        }
        match evaluate(&request, &ctx) {
            Err(reason) => Preview {
                accepted: false,
                refusal: Some(reason),
                raw: None,
                delivered_shares: None,
                to: None,
                calldata: None,
                unsigned_tx: None,
                sighash: None,
                is_replacement: false,
            },
            Ok(a) => Preview {
                accepted: true,
                refusal: None,
                raw: Some(U128(a.raw)),
                delivered_shares: Some(U128(a.delivered_shares)),
                to: Some(evm::address_hex(&a.tx.to)),
                calldata: Some(format!("0x{}", evm::to_hex(&a.tx.input))),
                unsigned_tx: Some(format!("0x{}", evm::to_hex(&a.tx.unsigned_bytes()))),
                sighash: Some(format!("0x{}", evm::to_hex(&a.tx.sighash()))),
                is_replacement: a.is_replacement,
            },
        }
    }

    /* ----------------------------- callback ---------------------------- */

    #[private]
    pub fn on_signed(
        &mut self,
        chain_id: u64,
        request_id: u64,
        #[callback_result] result: Result<Value, PromiseError>,
    ) -> Outcome {
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        let flight = match state.in_flight.take() {
            Some(f) if f.request_id == request_id => f,
            other => {
                // Cleared by the owner while signing; nothing to settle.
                state.in_flight = other;
                return Outcome::SignFailed {
                    request_id,
                    error: "request no longer in flight".into(),
                };
            }
        };

        match result {
            Ok(signature) => {
                if !flight.is_replacement {
                    state.next = flight.nonce + 1;
                }
                state.last_signed = Some(flight.record.clone());
                self.nonces.insert(chain_id, state);
                emit(
                    "signed",
                    json!({
                        "request_id": request_id,
                        "chain_id": chain_id,
                        "nonce": flight.nonce,
                        "unsigned_tx": flight.unsigned_tx,
                        "sighash": flight.sighash,
                        "signature": signature,
                    }),
                );
                Outcome::Signed {
                    request_id,
                    chain_id,
                    nonce: flight.nonce,
                    unsigned_tx: flight.unsigned_tx,
                    sighash: flight.sighash,
                    signature,
                }
            }
            Err(_) => {
                // Release the reservation: the nonce was never signed and the
                // raw never left.
                if let Ok(token) = evm::parse_address(&flight.token) {
                    let key = (chain_id, token);
                    if let Some(s) = self.spend.get(&key).cloned() {
                        if s.day == flight.day {
                            let spent = s.spent.saturating_sub(flight.reserved_raw.0);
                            self.spend.insert(key, DaySpend { day: s.day, spent });
                        }
                    }
                }
                self.nonces.insert(chain_id, state);
                emit(
                    "sign_failed",
                    json!({ "request_id": request_id, "chain_id": chain_id }),
                );
                Outcome::SignFailed {
                    request_id,
                    error: "MPC sign call failed or timed out".into(),
                }
            }
        }
    }

    /* ------------------------------ owner ------------------------------ */

    /// Owner-only: the capped `approve` Mode X needs, to the configured
    /// `ExactTransfer`. Signed through the same path and nonce rules.
    pub fn request_approve(
        &mut self,
        chain_id: u64,
        token: String,
        amount: U128,
        fees: Fees,
    ) -> PromiseOrValue<Outcome> {
        self.assert_owner();
        let now_s = now_s();
        let refuse = |reason: Refusal| {
            emit(
                "refused",
                json!({ "chain_id": chain_id, "token": token, "reason": reason }),
            );
            PromiseOrValue::Value(Outcome::Refused { reason })
        };
        let Some(chain) = self.chains.get(&chain_id).cloned() else {
            return refuse(Refusal::ChainNotAllowed);
        };
        let Ok(token_addr) = evm::parse_address(&token) else {
            return refuse(Refusal::TokenNotAllowed);
        };
        let Some(tp) = self.tokens.get(&(chain_id, token_addr)).cloned() else {
            return refuse(Refusal::TokenNotAllowed);
        };
        let Some(spender) = chain
            .exact_transfer
            .as_deref()
            .and_then(|a| evm::parse_address(a).ok())
        else {
            return refuse(Refusal::ModeNotAllowed);
        };
        if amount.0 > tp.max_raw_per_day.0 {
            return refuse(Refusal::AmountCapExceeded);
        }
        if fees.max_priority_fee_per_gas.0 > fees.max_fee_per_gas.0 || fees.gas_limit.0 == 0 {
            return refuse(Refusal::InvalidFees);
        }
        if fees.max_fee_per_gas.0 > chain.max_fee_per_gas.0
            || fees.max_priority_fee_per_gas.0 > chain.max_priority_fee_per_gas.0
            || fees.gas_limit.0 > chain.max_gas_limit.0
        {
            return refuse(Refusal::GasCapExceeded);
        }
        let tx = TxFields {
            chain_id,
            nonce: fees.evm_nonce,
            to: token_addr,
            input: evm::calldata_approve(&spender, amount.0),
            gas_limit: fees.gas_limit.0,
            max_fee_per_gas: fees.max_fee_per_gas.0,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas.0,
        };
        let state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        if state.in_flight.is_some() {
            return refuse(Refusal::RequestInFlight);
        }
        let ctx = Context {
            now_s,
            params: &self.params,
            chain: Some(&chain),
            token: Some(&tp),
            recipient_allowed: true,
            spent_today: 0,
            requests_today: 0,
            in_flight: false,
            next_nonce: state.next,
            last_signed: state.last_signed.as_ref(),
        };
        let is_replacement = match policy::check_nonce(&tx, &ctx) {
            Ok(r) => r,
            Err(reason) => return refuse(reason),
        };
        let approved = Approved {
            tx,
            raw: 0,
            delivered_shares: 0,
            is_replacement,
        };
        PromiseOrValue::Promise(self.reserve_and_sign(chain_id, token_addr, approved, now_s))
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(
            agent != env::current_account_id() && agent != self.owner,
            "agent must be a separate account"
        );
        self.agent = agent;
    }

    pub fn set_params(&mut self, params: Params) {
        self.assert_owner();
        require!(
            params.corp_action_window_s >= MIN_CORP_ACTION_WINDOW_S,
            "corp_action_window_s below the 600 s floor"
        );
        require!(
            params.max_observation_age_s > 0,
            "max_observation_age_s must be positive"
        );
        self.params = params;
    }

    /// Set the gas attached to the MPC `sign` call. Default 50 Tgas; the
    /// accepted range is 15 to 250 Tgas. Before deploying, read the live
    /// `sign_call_gas_attachment_requirement` from the signer contract and
    /// keep this value at or above it.
    pub fn set_sign_gas(&mut self, tgas: u64) {
        self.assert_owner();
        require!(
            (MIN_SIGN_GAS_TGAS..=250).contains(&tgas),
            "sign gas out of range"
        );
        self.sign_gas_tgas = tgas;
    }

    pub fn set_chain(&mut self, chain_id: u64, policy: ChainPolicy) {
        self.assert_owner();
        let on_testnet = env::current_account_id().as_str().ends_with(".testnet");
        require!(
            !(on_testnet && MAINNET_CHAIN_IDS.contains(&chain_id)),
            "mainnet chain on a testnet signer"
        );
        if let Some(a) = &policy.exact_transfer {
            require!(evm::parse_address(a).is_ok(), "bad exact_transfer address");
        }
        self.chains.insert(chain_id, policy);
    }

    pub fn remove_chain(&mut self, chain_id: u64) {
        self.assert_owner();
        self.chains.remove(&chain_id);
    }

    pub fn set_token(&mut self, chain_id: u64, token: String, policy: TokenPolicy) {
        self.assert_owner();
        require!(
            policy.max_raw_per_request.0 <= policy.max_raw_per_day.0,
            "per-request cap above daily cap"
        );
        self.tokens
            .insert((chain_id, parse_or_panic(&token)), policy);
    }

    pub fn remove_token(&mut self, chain_id: u64, token: String) {
        self.assert_owner();
        self.tokens.remove(&(chain_id, parse_or_panic(&token)));
    }

    pub fn set_recipient(&mut self, chain_id: u64, recipient: String, allowed: bool) {
        self.assert_owner();
        let key = (chain_id, parse_or_panic(&recipient));
        if allowed {
            self.recipients.insert(key, true);
        } else {
            self.recipients.remove(&key);
        }
    }

    /// Re-align with the chain after a signed transaction was never mined.
    pub fn reset_nonce(&mut self, chain_id: u64, next: u64) {
        self.assert_owner();
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        require!(state.in_flight.is_none(), "a request is in flight");
        state.next = next;
        state.last_signed = None;
        self.nonces.insert(chain_id, state);
    }

    /// Unstick a chain whose callback itself failed (for example, it ran out
    /// of gas). An MPC error or timeout does not need this: the callback
    /// still runs, receives the error and releases the reservation.
    /// Does **not** release the reserved daily budget or advance the nonce:
    /// the owner is asserting the request is dead, and any signature from it
    /// must not be used.
    pub fn clear_in_flight(&mut self, chain_id: u64) {
        self.assert_owner();
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        state.in_flight = None;
        self.nonces.insert(chain_id, state);
    }

    /* ------------------------------ views ------------------------------ */

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            signer: self.signer.clone(),
            path: self.path.clone(),
            sign_gas_tgas: self.sign_gas_tgas,
            params: self.params.clone(),
            requests_today: self.requests_today,
        }
    }

    pub fn get_chain(&self, chain_id: u64) -> Option<ChainPolicy> {
        self.chains.get(&chain_id).cloned()
    }

    pub fn get_token(&self, chain_id: u64, token: String) -> Option<TokenPolicy> {
        self.tokens
            .get(&(chain_id, parse_or_panic(&token)))
            .cloned()
    }

    pub fn is_recipient_allowed(&self, chain_id: u64, recipient: String) -> bool {
        self.recipients
            .contains_key(&(chain_id, parse_or_panic(&recipient)))
    }

    pub fn get_nonce_state(&self, chain_id: u64) -> NonceState {
        self.nonces.get(&chain_id).cloned().unwrap_or_default()
    }

    pub fn get_spent_today(&self, chain_id: u64, token: String) -> U128 {
        let day = now_s() / SECONDS_PER_DAY;
        match self.spend.get(&(chain_id, parse_or_panic(&token))) {
            Some(s) if s.day == day => U128(s.spent),
            _ => U128(0),
        }
    }
}

/* ------------------------------ internals ------------------------------ */

impl PolicySigner {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may do this"
        );
    }

    fn roll_day(&mut self, now_s: u64) {
        let day = now_s / SECONDS_PER_DAY;
        if day != self.request_day {
            self.request_day = day;
            self.requests_today = 0;
        }
    }

    fn context(
        &self,
        chain_id: u64,
        token: Option<Address>,
        recipient: Option<Address>,
        now_s: u64,
    ) -> Context<'_> {
        let day = now_s / SECONDS_PER_DAY;
        let state = self.nonces.get(&chain_id);
        Context {
            now_s,
            params: &self.params,
            chain: self.chains.get(&chain_id),
            token: token.and_then(|t| self.tokens.get(&(chain_id, t))),
            recipient_allowed: recipient
                .map(|r| self.recipients.contains_key(&(chain_id, r)))
                .unwrap_or(false),
            spent_today: token
                .and_then(|t| self.spend.get(&(chain_id, t)))
                .filter(|s| s.day == day)
                .map(|s| s.spent)
                .unwrap_or(0),
            requests_today: self.requests_today,
            in_flight: state.map(|s| s.in_flight.is_some()).unwrap_or(false),
            next_nonce: state.map(|s| s.next).unwrap_or(0),
            last_signed: state.and_then(|s| s.last_signed.as_ref()),
        }
    }

    /// Reserve the nonce and the cap budget, then call the MPC signer. The
    /// reservation happens before the cross-contract call, so two requests
    /// can never both pass on the same budget.
    fn reserve_and_sign(
        &mut self,
        chain_id: u64,
        token: Address,
        a: Approved,
        now_s: u64,
    ) -> Promise {
        let day = now_s / SECONDS_PER_DAY;
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.requests_today += 1;

        let reserved = if a.is_replacement { 0 } else { a.raw };
        if reserved > 0 {
            let key = (chain_id, token);
            let prev = self
                .spend
                .get(&key)
                .cloned()
                .filter(|s| s.day == day)
                .unwrap_or(DaySpend { day, spent: 0 });
            self.spend.insert(
                key,
                DaySpend {
                    day,
                    spent: prev.spent + reserved,
                },
            );
        }

        let unsigned = a.tx.unsigned_bytes();
        let sighash = a.tx.sighash();
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        state.in_flight = Some(InFlight {
            request_id,
            nonce: a.tx.nonce,
            token: evm::address_hex(&token),
            reserved_raw: U128(reserved),
            day,
            is_replacement: a.is_replacement,
            record: record_of(&a.tx),
            unsigned_tx: format!("0x{}", evm::to_hex(&unsigned)),
            sighash: format!("0x{}", evm::to_hex(&sighash)),
        });
        self.nonces.insert(chain_id, state);

        emit(
            "signing",
            json!({
                "request_id": request_id,
                "chain_id": chain_id,
                "nonce": a.tx.nonce,
                "to": evm::address_hex(&a.tx.to),
                "raw": U128(a.raw),
                "replacement": a.is_replacement,
            }),
        );

        let args = sign_args(&sighash, &self.path);
        Promise::new(self.signer.clone())
            .function_call(
                "sign".to_string(),
                args,
                NearToken::from_yoctonear(SIGN_DEPOSIT_YOCTO),
                Gas::from_tgas(self.sign_gas_tgas),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(chain_id, request_id),
            )
    }
}

/// Arguments for the MPC `sign` method: a secp256k1 payload (`domain_id` 0).
pub fn sign_args(sighash: &[u8; 32], path: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "request": {
            "payload_v2": { "Ecdsa": evm::to_hex(sighash) },
            "path": path,
            "domain_id": 0,
        }
    }))
    .expect("static json")
}

fn now_s() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn parse_or_panic(s: &str) -> Address {
    evm::parse_address(s).unwrap_or_else(|e| env::panic_str(&e))
}

fn emit(event: &str, data: Value) {
    let body = json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

#[cfg(test)]
mod tests;
