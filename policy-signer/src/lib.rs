//! Policy signer: a spending firewall for AI agents that move EVM assets.
//!
//! An agent asks this contract to send tokens on an EVM chain. The agent holds
//! no EVM key. This contract owns a Chain Signatures derived EVM address,
//! builds the exact transaction itself, checks it against the owner's policy
//! (and, for Stock Tokens, the share unit), and only then asks the NEAR MPC
//! network for a signature. The signed payload is exactly the payload the
//! policy checked.
//!
//! Roles, all separate accounts:
//! - owner: sets policy, approves queued requests, pauses, upgrades.
//! - agents: may call `request` and nothing else that changes state.
//! - signer: the MPC contract (`v1.signer-prod.testnet` / `v1.signer`).
//!
//! Deployment rules (see SECURITY.md): deploy and initialize in one
//! transaction (`new` is private), then delete every access key on this
//! account. Any key left on it could ask the MPC network for signatures
//! directly, without any policy check. Never delete this account: the derived
//! EVM address depends only on the account id and the path.

pub mod evm;
pub mod math;
pub mod policy;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

use evm::{Address, TxFields};
use policy::{
    check_fees, check_nonce, evaluate, record_of, AgentPolicy, ChainPolicy, Context, Decision,
    Fees, Params, Refusal, SignedRecord, Ticket, TicketStatus, TokenKind, TokenPolicy,
    TransferRequest, MAX_OPEN_TICKETS_LIMIT, MAX_POLICY_DELAY_S, MIN_CORP_ACTION_WINDOW_S,
    MIN_UPGRADE_DELAY_S,
};

/// Major EVM mainnets, never allowlisted on a testnet deployment: the testnet
/// MPC key must not sign mainnet payloads. Ethereum, Optimism, BNB Chain,
/// Gnosis, Polygon, Base, Arbitrum One, Avalanche C-Chain, Robinhood Chain.
pub const MAINNET_CHAIN_IDS: [u64; 9] = [1, 10, 56, 100, 137, 8453, 42161, 43114, 4663];
pub const STATE_VERSION: u32 = 1;
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const MIGRATE_GAS: Gas = Gas::from_tgas(30);
const MIN_SIGN_GAS_TGAS: u64 = 15;
/// Keeps sign gas + callback + own execution under a 300 Tgas transaction.
const MAX_SIGN_GAS_TGAS: u64 = 200;
const SECONDS_PER_DAY: u64 = 86_400;
const EVENT_STANDARD: &str = "policy-signer";
const EVENT_VERSION: &str = "2.0.0";

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    Testnet,
    Mainnet,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct DaySpend {
    pub day: u64,
    /// In the token's cap unit.
    pub spent: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct DayCount {
    pub day: u64,
    pub count: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub enum FlightKind {
    Transfer {
        agent: AccountId,
        ticket: Option<Ticket>,
    },
    Approve,
    Burn,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct InFlight {
    pub request_id: u64,
    pub kind: FlightKind,
    pub nonce: u64,
    pub token: Option<String>,
    pub reserved: U128,
    pub day: u64,
    pub is_replacement: bool,
    pub record: SignedRecord,
    pub unsigned_tx: String,
    pub sighash: String,
    pub started_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct NonceState {
    /// Next fresh nonce the contract will sign on this chain.
    pub next: u64,
    pub last_signed: Option<SignedRecord>,
    pub in_flight: Option<InFlight>,
}

/// A policy change, applied at once or after `policy_delay_s`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub enum PolicyChange {
    SetAgent {
        agent: AccountId,
        policy: AgentPolicy,
    },
    SetAgentCap {
        agent: AccountId,
        chain_id: u64,
        token: String,
        max_per_day: Option<U128>,
    },
    SetParams {
        params: Params,
    },
    SetSignGas {
        tgas: u64,
    },
    SetSignDeposit {
        yocto: U128,
    },
    SetChain {
        chain_id: u64,
        policy: ChainPolicy,
    },
    SetToken {
        chain_id: u64,
        token: String,
        policy: TokenPolicy,
    },
    AllowRecipient {
        chain_id: u64,
        recipient: String,
    },
    /// Proposing a new owner goes through the policy delay too, so a stolen
    /// owner key cannot hand the contract to its holder before the real owner
    /// can cancel. Appended last to keep the stored layout of earlier variants.
    ProposeOwner {
        new_owner: AccountId,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ScheduledChange {
    pub id: u64,
    pub change: PolicyChange,
    pub executable_at: u64,
}

pub const MAX_SCHEDULED_CHANGES: u32 = 50;
pub const MAX_RECIPIENTS_PER_CHAIN: usize = 200;
/// A burn may exceed the chain's fee caps to outbid a transaction signed at
/// the cap, but by at most this factor. This bounds each burn's fee, not the
/// number of burns.
pub const BURN_FEE_FACTOR: u128 = 3;
/// A zero-value transfer needs 21,000 gas; a little headroom, no more.
pub const BURN_MAX_GAS_LIMIT: u128 = 50_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingUpgrade {
    /// Hex sha256 of the new wasm.
    pub code_hash: String,
    pub executable_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "status")]
pub enum Outcome {
    #[serde(rename = "REFUSED")]
    Refused { reason: Refusal },
    /// Above `approval_above`: queued until the owner approves it.
    #[serde(rename = "PENDING_APPROVAL")]
    PendingApproval { ticket_id: u64, expires_at: u64 },
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
    /// "SIGN", "NEEDS_APPROVAL" or "REFUSED".
    pub decision: String,
    pub refusal: Option<Refusal>,
    pub cap_unit: Option<String>,
    pub cap_amount: Option<U128>,
    pub raw: Option<U128>,
    pub raw_is_estimate: bool,
    pub delivered_shares: Option<U128>,
    pub to: Option<String>,
    pub calldata: Option<String>,
    pub unsigned_tx: Option<String>,
    pub sighash: Option<String>,
    pub is_replacement: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct InFlightSummary {
    pub request_id: u64,
    pub nonce: u64,
    pub kind: String,
    pub age_s: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Status {
    pub paused: bool,
    pub next_nonce: u64,
    pub last_signed_nonce: Option<u64>,
    pub in_flight: Option<InFlightSummary>,
    pub chain: Option<ChainPolicy>,
    pub token: Option<TokenPolicy>,
    pub cap_unit: Option<String>,
    pub spent_today: U128,
    pub remaining_today: Option<U128>,
    pub requests_today: u32,
    pub max_requests_per_day: u32,
    pub open_tickets: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub version: u32,
    pub owner: AccountId,
    pub proposed_owner: Option<AccountId>,
    pub signer: AccountId,
    pub path: String,
    pub network: Network,
    pub paused: bool,
    pub sign_gas_tgas: u64,
    pub sign_deposit_yocto: U128,
    pub params: Params,
    pub requests_today: u32,
    pub pending_upgrade: Option<PendingUpgrade>,
    pub upgrades_disabled: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolicySigner {
    owner: AccountId,
    proposed_owner: Option<AccountId>,
    signer: AccountId,
    path: String,
    network: Network,
    paused: bool,
    sign_gas_tgas: u64,
    sign_deposit_yocto: u128,
    params: Params,
    agents: LookupMap<AccountId, AgentPolicy>,
    agent_caps: LookupMap<(AccountId, u64, Address), U128>,
    agent_spend: LookupMap<(AccountId, u64, Address), DaySpend>,
    agent_requests: LookupMap<AccountId, DayCount>,
    chains: LookupMap<u64, ChainPolicy>,
    tokens: LookupMap<(u64, Address), TokenPolicy>,
    recipients: LookupMap<(u64, Address), bool>,
    /// Allowlisted recipients per chain, kept as a list for the look-alike check.
    recipient_lists: LookupMap<u64, Vec<Address>>,
    spend: LookupMap<(u64, Address), DaySpend>,
    nonces: LookupMap<u64, NonceState>,
    tickets: IterableMap<u64, Ticket>,
    next_ticket_id: u64,
    request_day: u64,
    requests_today: u32,
    next_request_id: u64,
    pending_upgrade: Option<PendingUpgrade>,
    upgrades_disabled: bool,
    scheduled: IterableMap<u64, ScheduledChange>,
    next_change_id: u64,
}

#[near]
impl PolicySigner {
    /// Private: call it in the same transaction as the deploy, from this
    /// account, so nobody can initialize it first with their own owner.
    /// `path` is fixed forever: the derived EVM address depends on it.
    #[init]
    #[private]
    pub fn new(owner: AccountId, signer: AccountId, path: String, network: Network) -> Self {
        let me = env::current_account_id();
        // Same rule as #[private], checked again in the body.
        require!(
            env::predecessor_account_id() == me,
            "new must be called by this account"
        );
        require!(owner != me, "owner must be a separate account");
        require!(!path.is_empty(), "path must not be empty");
        let signer_on_testnet = signer.as_str().ends_with(".testnet");
        require!(
            signer_on_testnet == (network == Network::Testnet),
            "signer account does not match the network"
        );
        Self {
            owner,
            proposed_owner: None,
            signer,
            path,
            network,
            paused: false,
            sign_gas_tgas: 50,
            sign_deposit_yocto: 1,
            params: Params::default(),
            agents: LookupMap::new(b"a"),
            agent_caps: LookupMap::new(b"k"),
            agent_spend: LookupMap::new(b"x"),
            agent_requests: LookupMap::new(b"q"),
            chains: LookupMap::new(b"c"),
            tokens: LookupMap::new(b"t"),
            recipients: LookupMap::new(b"r"),
            recipient_lists: LookupMap::new(b"l"),
            spend: LookupMap::new(b"s"),
            nonces: LookupMap::new(b"n"),
            tickets: IterableMap::new(b"i"),
            next_ticket_id: 1,
            request_day: 0,
            requests_today: 0,
            next_request_id: 1,
            pending_upgrade: None,
            upgrades_disabled: false,
            scheduled: IterableMap::new(b"p"),
            next_change_id: 1,
        }
    }

    /// Called by `apply_upgrade` on the new code. State version 1 has no
    /// migration yet; a future layout change adds it here.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"))
    }

    /* ------------------------------ agents ----------------------------- */

    /// The agents' only state-changing method. Refusals are returned and
    /// logged as events, not panicked, so the reason is on chain.
    pub fn request(&mut self, request: TransferRequest) -> PromiseOrValue<Outcome> {
        let caller = env::predecessor_account_id();
        let now_s = now_s();
        self.roll_day(now_s);
        let token = evm::parse_address(&request.token).ok();
        let recipient = evm::parse_address(&request.recipient).ok();

        let decision = {
            let ctx = self.context(&caller, &request, token, recipient, now_s);
            evaluate(&request, &ctx)
        };
        match decision {
            Err(reason) => self.refuse(&caller, &request, reason),
            Ok(Decision::NeedsApproval { cap_amount }) => {
                self.queue(caller, &request, token, recipient, cap_amount, now_s)
            }
            Ok(Decision::Sign(approved)) => {
                let token = token.expect("checked by evaluate");
                let ticket = approved.ticket_id.and_then(|id| self.tickets.remove(&id));
                self.count_agent_request(&caller, now_s);
                let kind = FlightKind::Transfer {
                    agent: caller.clone(),
                    ticket,
                };
                let detail = json!({
                    "agent": caller,
                    "token": evm::address_hex(&token),
                    "recipient": request.recipient,
                    "kind": approved.kind,
                    "amount": request.amount,
                    "cap_unit": approved.kind.cap_unit(),
                    "cap_amount": U128(approved.cap_amount),
                    "raw": U128(approved.raw),
                    "raw_is_estimate": approved.kind == TokenKind::StockExact,
                });
                PromiseOrValue::Promise(self.reserve_and_sign(
                    request.chain_id,
                    Some(token),
                    Some(&caller),
                    approved.tx,
                    approved.cap_amount,
                    approved.is_replacement,
                    kind,
                    detail,
                    now_s,
                ))
            }
        }
    }

    /// Exactly what `request` from `agent` would decide right now, without
    /// reserving, queueing or signing.
    pub fn preview(&self, agent: AccountId, request: TransferRequest) -> Preview {
        let now_s = now_s();
        let token = evm::parse_address(&request.token).ok();
        let recipient = evm::parse_address(&request.recipient).ok();
        let mut ctx = self.context(&agent, &request, token, recipient, now_s);
        if self.request_day != now_s / SECONDS_PER_DAY {
            ctx.requests_today = 0;
        }
        let empty = |decision: &str, refusal: Option<Refusal>| Preview {
            decision: decision.into(),
            refusal,
            cap_unit: None,
            cap_amount: None,
            raw: None,
            raw_is_estimate: false,
            delivered_shares: None,
            to: None,
            calldata: None,
            unsigned_tx: None,
            sighash: None,
            is_replacement: false,
        };
        match evaluate(&request, &ctx) {
            Err(reason) => empty("REFUSED", Some(reason)),
            Ok(Decision::NeedsApproval { cap_amount }) => Preview {
                cap_amount: Some(U128(cap_amount)),
                cap_unit: ctx.token.map(|t| t.kind.cap_unit().to_string()),
                ..empty("NEEDS_APPROVAL", None)
            },
            Ok(Decision::Sign(a)) => Preview {
                decision: "SIGN".into(),
                refusal: None,
                cap_unit: Some(a.kind.cap_unit().into()),
                cap_amount: Some(U128(a.cap_amount)),
                raw: Some(U128(a.raw)),
                raw_is_estimate: a.kind == TokenKind::StockExact,
                delivered_shares: a.kind.is_stock().then_some(U128(a.delivered_shares)),
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
                // Cleared by the owner after the callback was presumed lost.
                state.in_flight = other;
                emit(
                    "late_callback",
                    json!({ "request_id": request_id, "chain_id": chain_id, "signed": result.is_ok() }),
                );
                return Outcome::SignFailed {
                    request_id,
                    error: "request no longer in flight".into(),
                };
            }
        };

        match result {
            Ok(signature) => {
                if !flight.is_replacement && flight.nonce >= state.next {
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
                        "kind": flight.kind,
                        "token": flight.token,
                        "to": flight.record.to,
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
                // Treat a failed sign call as possibly signed. After a timeout
                // the MPC nodes can still publish a valid signature in a late
                // transaction, so the nonce is not freed for a different call
                // and the budget is not released. The same requester can
                // re-sign the identical call as a fee bump at no extra budget,
                // or the owner can burn the nonce.
                if !flight.is_replacement && flight.nonce >= state.next {
                    state.next = flight.nonce + 1;
                }
                state.last_signed = Some(flight.record.clone());
                self.nonces.insert(chain_id, state);
                emit(
                    "sign_failed",
                    json!({
                        "request_id": request_id,
                        "chain_id": chain_id,
                        "nonce": flight.nonce,
                        "treated_as_possibly_signed": true,
                    }),
                );
                Outcome::SignFailed {
                    request_id,
                    error: "MPC sign call failed or timed out; re-sign the identical call as a fee bump, or burn the nonce".into(),
                }
            }
        }
    }

    /* ------------------------------ owner ------------------------------ */
    // Every owner method takes exactly 1 yoctoNEAR, so a function-call key on
    // the owner account (for example a dapp login key) cannot change policy.

    // Policy setters. With `policy_delay_s` at 0 they apply at once. Above 0
    // they are scheduled and take effect only through `execute_change` after
    // the delay, so a stolen owner key cannot loosen policy on the spot.
    // Removals and pause stay immediate: tightening never waits.

    #[payable]
    pub fn add_agent(&mut self, agent: AccountId, policy: AgentPolicy) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetAgent { agent, policy });
    }

    #[payable]
    pub fn remove_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agents.remove(&agent);
        emit("agent_removed", json!({ "agent": agent }));
    }

    /// An agent's own daily cap on one token, in the token's unit. `None`
    /// removes it; the global token caps always apply as well.
    #[payable]
    pub fn set_agent_cap(
        &mut self,
        agent: AccountId,
        chain_id: u64,
        token: String,
        max_per_day: Option<U128>,
    ) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetAgentCap {
            agent,
            chain_id,
            token,
            max_per_day,
        });
    }

    /// Pausing and resuming are immediate.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("paused", json!({ "paused": paused }));
    }

    #[payable]
    pub fn set_params(&mut self, params: Params) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetParams { params });
    }

    /// Gas attached to the MPC `sign` call. Default 50 Tgas, range 15 to 200.
    /// Keep it at or above the signer's live `sign_call_gas_attachment_requirement`.
    #[payable]
    pub fn set_sign_gas(&mut self, tgas: u64) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetSignGas { tgas });
    }

    /// Deposit attached to each `sign` call. 1 yoctoNEAR today; the MPC
    /// contract refunds any excess.
    #[payable]
    pub fn set_sign_deposit(&mut self, yocto: U128) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetSignDeposit { yocto });
    }

    #[payable]
    pub fn set_chain(&mut self, chain_id: u64, policy: ChainPolicy) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetChain { chain_id, policy });
    }

    #[payable]
    pub fn remove_chain(&mut self, chain_id: u64) {
        self.assert_owner();
        self.chains.remove(&chain_id);
        emit("chain_removed", json!({ "chain_id": chain_id }));
    }

    #[payable]
    pub fn set_token(&mut self, chain_id: u64, token: String, policy: TokenPolicy) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::SetToken {
            chain_id,
            token,
            policy,
        });
    }

    #[payable]
    pub fn remove_token(&mut self, chain_id: u64, token: String) {
        self.assert_owner();
        self.tokens.remove(&(chain_id, parse_or_panic(&token)));
        emit(
            "token_removed",
            json!({ "chain_id": chain_id, "token": token }),
        );
    }

    /// Allowing a recipient follows `policy_delay_s`; removing one is immediate.
    #[payable]
    pub fn set_recipient(&mut self, chain_id: u64, recipient: String, allowed: bool) {
        self.assert_owner();
        if allowed {
            self.apply_or_schedule(PolicyChange::AllowRecipient {
                chain_id,
                recipient,
            });
        } else {
            let addr = parse_or_panic(&recipient);
            self.recipients.remove(&(chain_id, addr));
            if let Some(mut list) = self.recipient_lists.get(&chain_id).cloned() {
                list.retain(|a| *a != addr);
                self.recipient_lists.insert(chain_id, list);
            }
            emit(
                "recipient_removed",
                json!({ "chain_id": chain_id, "recipient": recipient }),
            );
        }
    }

    /// Apply a scheduled change once its delay has passed.
    #[payable]
    pub fn execute_change(&mut self, change_id: u64) {
        self.assert_owner();
        let executable_at = self
            .scheduled
            .get(&change_id)
            .map(|c| c.executable_at)
            .unwrap_or_else(|| env::panic_str("no such change"));
        require!(now_s() >= executable_at, "change delay has not passed");
        let scheduled = self.scheduled.remove(&change_id).expect("checked above");
        self.apply_change(scheduled.change);
    }

    #[payable]
    pub fn cancel_change(&mut self, change_id: u64) {
        self.assert_owner();
        let scheduled = self
            .scheduled
            .remove(&change_id)
            .unwrap_or_else(|| env::panic_str("no such change"));
        emit("change_cancelled", json!({ "change": scheduled }));
    }

    /// Approve a queued request. The agent then re-sends it with a fresh
    /// observation and the ticket id, within `approved_ticket_ttl_s`.
    #[payable]
    pub fn approve_ticket(&mut self, ticket_id: u64) {
        self.assert_owner();
        let now = now_s();
        let mut t = self
            .tickets
            .get(&ticket_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such ticket"));
        require!(t.status == TicketStatus::Pending, "ticket is not pending");
        require!(now < t.expires_at, "ticket expired");
        t.status = TicketStatus::Approved;
        t.expires_at = now.saturating_add(self.params.approved_ticket_ttl_s);
        self.tickets.insert(ticket_id, t.clone());
        emit("ticket_approved", json!({ "ticket": t }));
    }

    #[payable]
    pub fn reject_ticket(&mut self, ticket_id: u64) {
        self.assert_owner();
        let t = self
            .tickets
            .remove(&ticket_id)
            .unwrap_or_else(|| env::panic_str("no such ticket"));
        emit("ticket_rejected", json!({ "ticket": t }));
    }

    /// The capped `approve` a `StockExact` token needs, to the chain's
    /// `ExactTransfer`. Signed through the same path and nonce rules; not
    /// counted against any agent budget.
    #[payable]
    pub fn request_approve(
        &mut self,
        chain_id: u64,
        token: String,
        amount: U128,
        fees: Fees,
    ) -> PromiseOrValue<Outcome> {
        self.assert_owner();
        let now = now_s();
        let token_addr = parse_or_panic(&token);
        let chain = self
            .chains
            .get(&chain_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("chain not allowed"));
        let tp = self
            .tokens
            .get(&(chain_id, token_addr))
            .cloned()
            .unwrap_or_else(|| env::panic_str("token not allowed"));
        require!(
            tp.kind == TokenKind::StockExact,
            "approve is only for StockExact tokens"
        );
        let spender = chain
            .exact_transfer
            .as_deref()
            .and_then(|a| evm::parse_address(a).ok())
            .unwrap_or_else(|| env::panic_str("no exact_transfer on chain"));
        let tx = TxFields {
            chain_id,
            nonce: fees.evm_nonce,
            to: token_addr,
            value: 0,
            input: evm::calldata_approve(&spender, amount.0),
            gas_limit: fees.gas_limit.0,
            max_fee_per_gas: fees.max_fee_per_gas.0,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas.0,
        };
        self.owner_sign(
            chain_id,
            Some(token_addr),
            &chain,
            &fees,
            tx,
            FlightKind::Approve,
            now,
        )
    }

    /// Invalidate signatures that were issued but may not have been mined:
    /// sign a zero-value transaction to the burn address at `nonce`, which
    /// must be at most the next fresh nonce. Works while paused. To void every
    /// outstanding signature, burn each nonce from the chain's current account
    /// nonce up to `next_nonce - 1`, with fees above any copy in a mempool.
    #[payable]
    pub fn burn_nonce(&mut self, chain_id: u64, fees: Fees) -> PromiseOrValue<Outcome> {
        self.assert_owner();
        let now = now_s();
        let chain = self
            .chains
            .get(&chain_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("chain not allowed"));
        let next = self.nonces.get(&chain_id).map(|s| s.next).unwrap_or(0);
        require!(
            fees.evm_nonce <= next,
            "can only burn a nonce up to the next fresh one"
        );
        let tx = TxFields {
            chain_id,
            nonce: fees.evm_nonce,
            to: evm::BURN_ADDRESS,
            value: 0,
            input: vec![],
            gas_limit: fees.gas_limit.0,
            max_fee_per_gas: fees.max_fee_per_gas.0,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas.0,
        };
        self.owner_sign(chain_id, None, &chain, &fees, tx, FlightKind::Burn, now)
    }

    /// Re-align with the chain after a signed transaction was never mined.
    #[payable]
    pub fn reset_nonce(&mut self, chain_id: u64, next: u64) {
        self.assert_owner();
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        require!(state.in_flight.is_none(), "a request is in flight");
        state.next = next;
        state.last_signed = None;
        self.nonces.insert(chain_id, state);
        emit("nonce_reset", json!({ "chain_id": chain_id, "next": next }));
    }

    /// Only for a callback that itself failed (for example, out of gas). An
    /// MPC error or timeout does not need this: the callback receives the
    /// error and records the request as possibly signed. Clearing releases
    /// nothing and does not advance the nonce. If the MPC did sign, that
    /// signature is public in its receipt; void it with `burn_nonce`.
    #[payable]
    pub fn clear_in_flight(&mut self, chain_id: u64) {
        self.assert_owner();
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        let cleared = state.in_flight.take();
        self.nonces.insert(chain_id, state);
        emit(
            "in_flight_cleared",
            json!({ "chain_id": chain_id, "request_id": cleared.map(|f| f.request_id) }),
        );
    }

    /// Two-step ownership transfer: the new owner must accept.
    #[payable]
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.apply_or_schedule(PolicyChange::ProposeOwner { new_owner });
    }

    #[payable]
    pub fn accept_owner(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            self.proposed_owner.as_ref() == Some(&caller),
            "not the proposed owner"
        );
        require!(
            !self.agents.contains_key(&caller),
            "an agent cannot become the owner"
        );
        let previous = std::mem::replace(&mut self.owner, caller.clone());
        self.proposed_owner = None;
        emit("owner_changed", json!({ "from": previous, "to": caller }));
    }

    /// Announce a code upgrade. It can be applied after `upgrade_delay_s`
    /// (default 48 h, floor 24 h), which gives anyone watching the
    /// `upgrade_proposed` event time to react.
    #[payable]
    pub fn propose_upgrade(&mut self, code_hash: String) {
        self.assert_owner();
        require!(!self.upgrades_disabled, "upgrades are disabled");
        let hash = code_hash.trim_start_matches("0x").to_ascii_lowercase();
        require!(
            hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "code_hash must be 32 bytes hex"
        );
        let pending = PendingUpgrade {
            code_hash: hash,
            executable_at: now_s().saturating_add(self.params.upgrade_delay_s),
        };
        emit("upgrade_proposed", json!({ "upgrade": pending }));
        self.pending_upgrade = Some(pending);
    }

    /// Make the code permanent. Irreversible: no later owner can upgrade.
    #[payable]
    pub fn disable_upgrades(&mut self) {
        self.assert_owner();
        self.upgrades_disabled = true;
        self.pending_upgrade = None;
        emit("upgrades_disabled", json!({}));
    }

    #[payable]
    pub fn cancel_upgrade(&mut self) {
        self.assert_owner();
        self.pending_upgrade = None;
        emit("upgrade_cancelled", json!({}));
    }

    #[payable]
    pub fn apply_upgrade(&mut self, code: Base64VecU8) -> Promise {
        self.assert_owner();
        require!(!self.upgrades_disabled, "upgrades are disabled");
        let pending = self
            .pending_upgrade
            .take()
            .unwrap_or_else(|| env::panic_str("no upgrade proposed"));
        require!(
            now_s() >= pending.executable_at,
            "upgrade delay has not passed"
        );
        require!(
            evm::to_hex(&env::sha256(&code.0)) == pending.code_hash,
            "code does not match the proposed hash"
        );
        // If `migrate` fails, the deploy in the same receipt is reverted too and
        // the old code stays; the owner then proposes again.
        emit("upgrade_started", json!({ "code_hash": pending.code_hash }));
        Promise::new(env::current_account_id())
            .deploy_contract(code.0)
            .function_call(
                "migrate".to_string(),
                vec![],
                NearToken::from_yoctonear(0),
                MIGRATE_GAS,
            )
    }

    /* ------------------------------ views ------------------------------ */

    pub fn get_config(&self) -> Config {
        Config {
            version: STATE_VERSION,
            owner: self.owner.clone(),
            proposed_owner: self.proposed_owner.clone(),
            signer: self.signer.clone(),
            path: self.path.clone(),
            network: self.network,
            paused: self.paused,
            sign_gas_tgas: self.sign_gas_tgas,
            sign_deposit_yocto: U128(self.sign_deposit_yocto),
            params: self.params.clone(),
            requests_today: self.requests_today,
            pending_upgrade: self.pending_upgrade.clone(),
            upgrades_disabled: self.upgrades_disabled,
        }
    }

    /// Everything an operator needs for one chain and token, in one call.
    pub fn get_status(&self, chain_id: u64, token: Option<String>) -> Status {
        let now = now_s();
        let day = now / SECONDS_PER_DAY;
        let state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        let token_addr = token.as_deref().and_then(|t| evm::parse_address(t).ok());
        let token_policy = token_addr.and_then(|t| self.tokens.get(&(chain_id, t)).cloned());
        let spent = token_addr
            .and_then(|t| self.spend.get(&(chain_id, t)))
            .filter(|s| s.day == day)
            .map(|s| s.spent)
            .unwrap_or(0);
        Status {
            paused: self.paused,
            next_nonce: state.next,
            last_signed_nonce: state.last_signed.as_ref().map(|r| r.nonce),
            in_flight: state.in_flight.as_ref().map(|f| InFlightSummary {
                request_id: f.request_id,
                nonce: f.nonce,
                kind: match f.kind {
                    FlightKind::Transfer { .. } => "transfer",
                    FlightKind::Approve => "approve",
                    FlightKind::Burn => "burn",
                }
                .into(),
                age_s: now.saturating_sub(f.started_at),
            }),
            chain: self.chains.get(&chain_id).cloned(),
            cap_unit: token_policy.as_ref().map(|t| t.kind.cap_unit().into()),
            remaining_today: token_policy
                .as_ref()
                .map(|t| U128(t.max_per_day.0.saturating_sub(spent))),
            token: token_policy,
            spent_today: U128(spent),
            requests_today: if self.request_day == day {
                self.requests_today
            } else {
                0
            },
            max_requests_per_day: self.params.max_requests_per_day,
            open_tickets: self.tickets.len(),
        }
    }

    pub fn get_agent(&self, agent: AccountId) -> Option<AgentPolicy> {
        self.agents.get(&agent).cloned()
    }

    pub fn get_agent_usage(&self, agent: AccountId, chain_id: u64, token: String) -> Value {
        let day = now_s() / SECONDS_PER_DAY;
        let key = (agent.clone(), chain_id, parse_or_panic(&token));
        let spent = self
            .agent_spend
            .get(&key)
            .filter(|s| s.day == day)
            .map(|s| s.spent)
            .unwrap_or(0);
        let requests = self
            .agent_requests
            .get(&agent)
            .filter(|c| c.day == day)
            .map(|c| c.count)
            .unwrap_or(0);
        json!({
            "spent_today": U128(spent),
            "cap_per_day": self.agent_caps.get(&key),
            "requests_today": requests,
        })
    }

    pub fn get_chain(&self, chain_id: u64) -> Option<ChainPolicy> {
        self.chains.get(&chain_id).cloned()
    }

    pub fn get_token(&self, chain_id: u64, token: String) -> Option<TokenPolicy> {
        self.tokens
            .get(&(chain_id, parse_or_panic(&token)))
            .cloned()
    }

    pub fn list_recipients(&self, chain_id: u64) -> Vec<String> {
        self.recipient_lists
            .get(&chain_id)
            .map(|l| l.iter().map(evm::address_hex).collect())
            .unwrap_or_default()
    }

    pub fn is_recipient_allowed(&self, chain_id: u64, recipient: String) -> bool {
        self.recipients
            .contains_key(&(chain_id, parse_or_panic(&recipient)))
    }

    pub fn get_nonce_state(&self, chain_id: u64) -> NonceState {
        self.nonces.get(&chain_id).cloned().unwrap_or_default()
    }

    pub fn list_scheduled_changes(&self) -> Vec<ScheduledChange> {
        self.scheduled.values().cloned().collect()
    }

    pub fn get_ticket(&self, ticket_id: u64) -> Option<Ticket> {
        self.tickets.get(&ticket_id).cloned()
    }

    pub fn list_tickets(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Ticket> {
        self.tickets
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    /// Spent today on a token, in the token's cap unit.
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
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may do this"
        );
    }

    fn apply_or_schedule(&mut self, change: PolicyChange) {
        self.check_change(&change);
        let delay = self.params.policy_delay_s;
        if delay == 0 {
            self.apply_change(change);
            return;
        }
        require!(
            self.scheduled.len() < MAX_SCHEDULED_CHANGES,
            "too many scheduled changes"
        );
        let id = self.next_change_id;
        self.next_change_id += 1;
        let scheduled = ScheduledChange {
            id,
            change,
            executable_at: now_s().saturating_add(delay),
        };
        emit("change_scheduled", json!({ "change": scheduled }));
        self.scheduled.insert(id, scheduled);
    }

    /// Validation shared by scheduling and execution, so a change that was
    /// valid when scheduled is checked again against the state it lands in.
    fn check_change(&self, change: &PolicyChange) {
        match change {
            PolicyChange::ProposeOwner { new_owner } => require!(
                *new_owner != env::current_account_id() && !self.agents.contains_key(new_owner),
                "owner must be a separate, non-agent account"
            ),
            PolicyChange::SetAgent { agent, .. } => require!(
                *agent != env::current_account_id() && *agent != self.owner,
                "an agent must be a separate account"
            ),
            PolicyChange::SetAgentCap { token, .. } => {
                parse_or_panic(token);
            }
            PolicyChange::SetParams { params } => {
                require!(
                    params.corp_action_window_s >= MIN_CORP_ACTION_WINDOW_S,
                    "corp_action_window_s below the 600 s floor"
                );
                require!(
                    params.max_observation_age_s > 0,
                    "max_observation_age_s must be positive"
                );
                require!(
                    params.upgrade_delay_s >= MIN_UPGRADE_DELAY_S,
                    "upgrade_delay_s below the 24 h floor"
                );
                require!(
                    params.upgrade_delay_s >= self.params.upgrade_delay_s,
                    "upgrade_delay_s can only be raised"
                );
                require!(
                    params.max_open_tickets > 0
                        && params.max_open_tickets <= MAX_OPEN_TICKETS_LIMIT,
                    "max_open_tickets out of range"
                );
                require!(
                    params.approved_ticket_ttl_s > 0 && params.pending_ticket_ttl_s > 0,
                    "ticket lifetimes must be positive"
                );
                require!(
                    params.policy_delay_s <= MAX_POLICY_DELAY_S,
                    "policy_delay_s above 30 days"
                );
            }
            PolicyChange::SetSignGas { tgas } => require!(
                (MIN_SIGN_GAS_TGAS..=MAX_SIGN_GAS_TGAS).contains(tgas),
                "sign gas out of range"
            ),
            PolicyChange::SetSignDeposit { yocto } => {
                require!(yocto.0 >= 1, "deposit must be at least 1 yoctoNEAR")
            }
            PolicyChange::SetChain { chain_id, policy } => {
                require!(
                    !(self.network == Network::Testnet && MAINNET_CHAIN_IDS.contains(chain_id)),
                    "mainnet chain on a testnet signer"
                );
                if let Some(a) = &policy.exact_transfer {
                    require!(evm::parse_address(a).is_ok(), "bad exact_transfer address");
                }
            }
            PolicyChange::SetToken {
                chain_id,
                token,
                policy,
            } => {
                require!(
                    policy.max_per_request.0 <= policy.max_per_day.0,
                    "per-request cap above daily cap"
                );
                if let Some(soft) = policy.approval_above {
                    require!(
                        soft.0 < policy.max_per_request.0,
                        "approval_above must be below max_per_request"
                    );
                }
                let token_addr = parse_or_panic(token);
                require!(
                    (policy.kind == TokenKind::Native) == (token_addr == evm::NATIVE),
                    "Native uses the zero address, and only Native does"
                );
                if policy.kind == TokenKind::StockExact {
                    let has_exact = self
                        .chains
                        .get(chain_id)
                        .and_then(|c| c.exact_transfer.as_ref())
                        .is_some();
                    require!(has_exact, "StockExact needs exact_transfer on the chain");
                }
            }
            PolicyChange::AllowRecipient { recipient, .. } => {
                parse_or_panic(recipient);
            }
        }
    }

    fn apply_change(&mut self, change: PolicyChange) {
        self.check_change(&change);
        emit("policy_changed", json!({ "change": change }));
        match change {
            PolicyChange::SetAgent { agent, policy } => {
                self.agents.insert(agent, policy);
            }
            PolicyChange::SetAgentCap {
                agent,
                chain_id,
                token,
                max_per_day,
            } => {
                let key = (agent, chain_id, parse_or_panic(&token));
                match max_per_day {
                    Some(cap) => {
                        self.agent_caps.insert(key, cap);
                    }
                    None => {
                        self.agent_caps.remove(&key);
                    }
                }
            }
            PolicyChange::SetParams { params } => self.params = params,
            PolicyChange::SetSignGas { tgas } => self.sign_gas_tgas = tgas,
            PolicyChange::SetSignDeposit { yocto } => self.sign_deposit_yocto = yocto.0,
            PolicyChange::SetChain { chain_id, policy } => {
                self.chains.insert(chain_id, policy);
            }
            PolicyChange::SetToken {
                chain_id,
                token,
                policy,
            } => {
                self.tokens
                    .insert((chain_id, parse_or_panic(&token)), policy);
            }
            PolicyChange::ProposeOwner { new_owner } => {
                emit("owner_proposed", json!({ "to": new_owner }));
                self.proposed_owner = Some(new_owner);
            }
            PolicyChange::AllowRecipient {
                chain_id,
                recipient,
            } => {
                let addr = parse_or_panic(&recipient);
                if self.recipients.insert((chain_id, addr), true).is_none() {
                    let mut list = self
                        .recipient_lists
                        .get(&chain_id)
                        .cloned()
                        .unwrap_or_default();
                    require!(
                        list.len() < MAX_RECIPIENTS_PER_CHAIN,
                        "too many recipients on this chain"
                    );
                    list.push(addr);
                    self.recipient_lists.insert(chain_id, list);
                }
            }
        }
    }

    /// Same first two and last two bytes (four hex digits each) as an
    /// allowlisted recipient on this chain, but a different address.
    fn is_lookalike(&self, chain_id: u64, r: &Address) -> bool {
        self.recipient_lists
            .get(&chain_id)
            .map(|list| {
                list.iter()
                    .any(|a| a != r && a[..2] == r[..2] && a[18..] == r[18..])
            })
            .unwrap_or(false)
    }

    fn roll_day(&mut self, now_s: u64) {
        let day = now_s / SECONDS_PER_DAY;
        if day != self.request_day {
            self.request_day = day;
            self.requests_today = 0;
        }
    }

    fn count_agent_request(&mut self, agent: &AccountId, now_s: u64) {
        let day = now_s / SECONDS_PER_DAY;
        let prev = self
            .agent_requests
            .get(agent)
            .cloned()
            .filter(|c| c.day == day);
        self.agent_requests.insert(
            agent.clone(),
            DayCount {
                day,
                count: prev.map(|c| c.count).unwrap_or(0) + 1,
            },
        );
        self.requests_today += 1;
    }

    fn context<'a>(
        &'a self,
        caller: &'a AccountId,
        request: &TransferRequest,
        token: Option<Address>,
        recipient: Option<Address>,
        now_s: u64,
    ) -> Context<'a> {
        let day = now_s / SECONDS_PER_DAY;
        let chain_id = request.chain_id;
        let state = self.nonces.get(&chain_id);
        let agent_key = token.map(|t| (caller.clone(), chain_id, t));
        Context {
            now_s,
            params: &self.params,
            paused: self.paused,
            agent: self.agents.get(caller),
            agent_requests_today: self
                .agent_requests
                .get(caller)
                .filter(|c| c.day == day)
                .map(|c| c.count)
                .unwrap_or(0),
            requests_today: self.requests_today,
            chain: self.chains.get(&chain_id),
            token: token.and_then(|t| self.tokens.get(&(chain_id, t))),
            recipient_allowed: recipient
                .map(|r| self.recipients.contains_key(&(chain_id, r)))
                .unwrap_or(false),
            recipient_lookalike: recipient
                .map(|r| self.is_lookalike(chain_id, &r))
                .unwrap_or(false),
            spent_today: token
                .and_then(|t| self.spend.get(&(chain_id, t)))
                .filter(|s| s.day == day)
                .map(|s| s.spent)
                .unwrap_or(0),
            agent_cap: agent_key
                .as_ref()
                .and_then(|k| self.agent_caps.get(k))
                .map(|c| c.0),
            agent_spent_today: agent_key
                .as_ref()
                .and_then(|k| self.agent_spend.get(k))
                .filter(|s| s.day == day)
                .map(|s| s.spent)
                .unwrap_or(0),
            in_flight: state.map(|s| s.in_flight.is_some()).unwrap_or(false),
            next_nonce: state.map(|s| s.next).unwrap_or(0),
            last_signed: state.and_then(|s| s.last_signed.as_ref()),
            ticket: request.ticket_id.and_then(|id| self.tickets.get(&id)),
            caller,
        }
    }

    fn refuse(
        &self,
        caller: &AccountId,
        request: &TransferRequest,
        reason: Refusal,
    ) -> PromiseOrValue<Outcome> {
        emit(
            "refused",
            json!({
                "agent": caller,
                "chain_id": request.chain_id,
                "token": request.token,
                "recipient": request.recipient,
                "amount": request.amount,
                "reason": reason,
            }),
        );
        PromiseOrValue::Value(Outcome::Refused { reason })
    }

    fn queue(
        &mut self,
        agent: AccountId,
        request: &TransferRequest,
        token: Option<Address>,
        recipient: Option<Address>,
        cap_amount: u128,
        now_s: u64,
    ) -> PromiseOrValue<Outcome> {
        // Drop expired tickets before counting, so stale ones cannot fill the queue.
        let expired: Vec<u64> = self
            .tickets
            .iter()
            .filter(|(_, t)| t.expires_at <= now_s)
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            self.tickets.remove(&id);
        }
        if self.tickets.len() >= self.params.max_open_tickets {
            return self.refuse(&agent, request, Refusal::QueueFull);
        }
        let id = self.next_ticket_id;
        self.next_ticket_id += 1;
        let ticket = Ticket {
            id,
            agent,
            chain_id: request.chain_id,
            token: evm::address_hex(&token.expect("checked by evaluate")),
            recipient: evm::address_hex(&recipient.expect("checked by evaluate")),
            amount: request.amount,
            cap_amount: U128(cap_amount),
            status: TicketStatus::Pending,
            created_at: now_s,
            expires_at: now_s.saturating_add(self.params.pending_ticket_ttl_s),
        };
        emit(
            "escalated",
            json!({ "ticket": ticket, "cap_amount": U128(cap_amount) }),
        );
        let expires_at = ticket.expires_at;
        self.tickets.insert(id, ticket);
        PromiseOrValue::Value(Outcome::PendingApproval {
            ticket_id: id,
            expires_at,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn owner_sign(
        &mut self,
        chain_id: u64,
        token: Option<Address>,
        chain: &ChainPolicy,
        fees: &Fees,
        tx: TxFields,
        kind: FlightKind,
        now_s: u64,
    ) -> PromiseOrValue<Outcome> {
        let fee_check = match kind {
            // A burn must be able to outbid a transaction signed at the cap,
            // so only the fees' internal consistency is checked.
            FlightKind::Burn => {
                if fees.max_priority_fee_per_gas.0 > fees.max_fee_per_gas.0 || fees.gas_limit.0 == 0
                {
                    Err(Refusal::InvalidFees)
                } else if fees.max_fee_per_gas.0
                    > chain.max_fee_per_gas.0.saturating_mul(BURN_FEE_FACTOR)
                    || fees.max_priority_fee_per_gas.0
                        > chain
                            .max_priority_fee_per_gas
                            .0
                            .saturating_mul(BURN_FEE_FACTOR)
                    || fees.gas_limit.0 > BURN_MAX_GAS_LIMIT
                {
                    Err(Refusal::GasCapExceeded)
                } else {
                    Ok(())
                }
            }
            _ => check_fees(fees, chain),
        };
        if let Err(reason) = fee_check {
            env::panic_str(&format!("{reason:?}"));
        }
        let state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        require!(state.in_flight.is_none(), "a request is in flight");
        let is_replacement = match kind {
            // A burn may reuse any nonce up to `next`; that is its purpose.
            FlightKind::Burn => tx.nonce < state.next,
            _ => check_nonce(&tx, state.next, state.last_signed.as_ref(), None)
                .unwrap_or_else(|r| env::panic_str(&format!("{r:?}"))),
        };
        let detail = json!({ "owner_action": kind, "to": evm::address_hex(&tx.to) });
        PromiseOrValue::Promise(self.reserve_and_sign(
            chain_id,
            token,
            None,
            tx,
            0,
            is_replacement,
            kind,
            detail,
            now_s,
        ))
    }

    /// Reserve the nonce and the budget, then call the MPC signer. The
    /// reservation happens before the cross-contract call, so two requests
    /// can never both pass on the same budget.
    #[allow(clippy::too_many_arguments)]
    fn reserve_and_sign(
        &mut self,
        chain_id: u64,
        token: Option<Address>,
        agent: Option<&AccountId>,
        tx: TxFields,
        cap_amount: u128,
        is_replacement: bool,
        kind: FlightKind,
        detail: Value,
        now_s: u64,
    ) -> Promise {
        let day = now_s / SECONDS_PER_DAY;
        let request_id = self.next_request_id;
        self.next_request_id += 1;

        let reserved = if is_replacement { 0 } else { cap_amount };
        if let (Some(t), true) = (token, reserved > 0) {
            reserve(&mut self.spend, (chain_id, t), day, reserved);
            if let Some(a) = agent {
                reserve(
                    &mut self.agent_spend,
                    (a.clone(), chain_id, t),
                    day,
                    reserved,
                );
            }
        }

        let unsigned = tx.unsigned_bytes();
        let sighash = tx.sighash();
        let mut state = self.nonces.get(&chain_id).cloned().unwrap_or_default();
        state.in_flight = Some(InFlight {
            request_id,
            kind,
            nonce: tx.nonce,
            token: token.map(|t| evm::address_hex(&t)),
            reserved: U128(reserved),
            day,
            is_replacement,
            record: record_of(&tx, agent),
            unsigned_tx: format!("0x{}", evm::to_hex(&unsigned)),
            sighash: format!("0x{}", evm::to_hex(&sighash)),
            started_at: now_s,
        });
        self.nonces.insert(chain_id, state);

        emit(
            "signing",
            json!({
                "request_id": request_id,
                "chain_id": chain_id,
                "nonce": tx.nonce,
                "to": evm::address_hex(&tx.to),
                "replacement": is_replacement,
                "detail": detail,
            }),
        );

        Promise::new(self.signer.clone())
            .function_call(
                "sign".to_string(),
                sign_args(&sighash, &self.path),
                NearToken::from_yoctonear(self.sign_deposit_yocto),
                Gas::from_tgas(self.sign_gas_tgas),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(chain_id, request_id),
            )
    }
}

fn reserve<K: near_sdk::borsh::BorshSerialize + Ord + Clone>(
    map: &mut LookupMap<K, DaySpend>,
    key: K,
    day: u64,
    amount: u128,
) {
    let prev = map
        .get(&key)
        .cloned()
        .filter(|s| s.day == day)
        .unwrap_or(DaySpend { day, spent: 0 });
    map.insert(
        key,
        DaySpend {
            day,
            spent: prev.spent.saturating_add(amount),
        },
    );
}

/// Arguments for the MPC `sign` method: a secp256k1 payload (`domain_id` 0).
/// The payload is hex without `0x`, as the MPC contract requires.
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
