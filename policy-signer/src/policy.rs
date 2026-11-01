//! The policy decision, as a pure function of stored policy, the request and
//! the current time. `request` and `preview` both call it, so a preview can
//! never disagree with what a request would do.

use near_sdk::json_types::U128;
use near_sdk::near;

use crate::evm::{self, Address, TxFields};
use crate::math;

/// Every reason C1 refuses to ask for a signature. Where a refusal means the
/// same condition as a ShareExact contract error, it carries the same name
/// (`MultiplierChangePending`, `UnitUnavailable`, `ShareShortfall`,
/// `ZeroAmount`), so no caller has to translate.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    ChainNotAllowed,
    TokenNotAllowed,
    RecipientNotAllowed,
    ModeNotAllowed,
    ObservationIncomplete,
    StaleObservation,
    UnitUnavailable,
    ObservationCrossedChange,
    MultiplierChangePending,
    ZeroAmount,
    ShareShortfall,
    AmountCapExceeded,
    GasCapExceeded,
    InvalidFees,
    RequestInFlight,
    NonceOutOfOrder,
    InvalidReplacement,
    RequestCapExceeded,
}

/// How shares leave the derived address.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Mode X: `ExactTransfer.transferShares`. The EVM re-reads the multiplier
    /// at execution, so a wrong observation cannot change the shares delivered.
    Exact,
    /// Mode D: plain ERC-20 `transfer` of a raw amount C1 computes from the
    /// observation. Bounded by caps and allowlists only.
    Direct,
}

/// What C2 read from the token, at which block.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Observation {
    /// `uiMultiplier()`, 18 decimals.
    pub multiplier: U128,
    /// `newUIMultiplier()`. Required: a missing value fails closed.
    pub new_multiplier: Option<U128>,
    /// `effectiveAt()`, unix seconds; 0 means nothing scheduled. Required.
    pub effective_at: Option<u64>,
    pub block_number: u64,
    /// Timestamp of the block the reads came from, unix seconds.
    pub block_timestamp: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Fees {
    pub evm_nonce: u64,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TransferRequest {
    pub chain_id: u64,
    pub token: String,
    pub recipient: String,
    /// Shares, 18 decimals (1 share = 1e18).
    pub ui_shares: U128,
    /// Shares the requester accepts losing to floor rounding, 18 decimals.
    pub max_shortfall: U128,
    pub mode: Mode,
    pub observed: Observation,
    pub fees: Fees,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ChainPolicy {
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub max_gas_limit: U128,
    /// ShareExact `ExactTransfer` on this chain. `None` disables Mode X.
    pub exact_transfer: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TokenPolicy {
    /// Raw-unit caps. Hard in Direct mode, where the raw amount is in the
    /// calldata.
    pub max_raw_per_request: U128,
    pub max_raw_per_day: U128,
    /// Share caps, 18 decimals. Hard in Exact mode, where the share amount is
    /// in the calldata and the chain converts it at execution. Both pairs
    /// apply in both modes, so a false multiplier cannot move more than
    /// either cap allows.
    pub max_shares_per_request: U128,
    pub max_shares_per_day: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Params {
    /// Oldest observation accepted, seconds. Proposed 120.
    pub max_observation_age_s: u64,
    /// How far an observation may sit ahead of NEAR's clock, seconds. The two
    /// chains keep separate clocks; anything beyond this counts as stale.
    pub max_clock_skew_s: u64,
    /// Seconds before a scheduled multiplier change in which transfers are
    /// refused. Floor 600, same as `ShareExactGuard.MIN_CORP_ACTION_WINDOW`.
    pub corp_action_window_s: u64,
    /// Requests accepted per UTC day across all chains.
    pub max_requests_per_day: u32,
}

pub const MIN_CORP_ACTION_WINDOW_S: u64 = 600;

impl Default for Params {
    fn default() -> Self {
        Self {
            max_observation_age_s: 120,
            max_clock_skew_s: 15,
            corp_action_window_s: 7_200,
            max_requests_per_day: 50,
        }
    }
}

/// The last transaction C1 signed on a chain: the only one it will re-sign,
/// and only as a fee bump of the identical call.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedRecord {
    pub nonce: u64,
    pub to: String,
    pub input_hash: String,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

/// Everything the policy needs to see about stored state for one request.
pub struct Context<'a> {
    pub now_s: u64,
    pub params: &'a Params,
    pub chain: Option<&'a ChainPolicy>,
    pub token: Option<&'a TokenPolicy>,
    pub recipient_allowed: bool,
    /// Raw already spent today on this (chain, token).
    pub spent_today: u128,
    /// Shares already spent today on this (chain, token), 18 decimals.
    pub shares_spent_today: u128,
    pub requests_today: u32,
    pub in_flight: bool,
    pub next_nonce: u64,
    pub last_signed: Option<&'a SignedRecord>,
}

/// An accepted request, ready to sign.
#[derive(Clone, Debug)]
pub struct Approved {
    pub tx: TxFields,
    /// Shares requested, 18 decimals; reserved against the daily share cap.
    pub ui_shares: u128,
    /// Raw units leaving the derived address, by C1's own computation.
    pub raw: u128,
    /// Shares those raw units represent after flooring.
    pub delivered_shares: u128,
    pub is_replacement: bool,
}

pub fn evaluate(req: &TransferRequest, ctx: &Context) -> Result<Approved, Refusal> {
    // Cheap global gates first.
    if ctx.requests_today >= ctx.params.max_requests_per_day {
        return Err(Refusal::RequestCapExceeded);
    }
    if ctx.in_flight {
        return Err(Refusal::RequestInFlight);
    }

    // Who and what.
    let chain = ctx.chain.ok_or(Refusal::ChainNotAllowed)?;
    let token_policy = ctx.token.ok_or(Refusal::TokenNotAllowed)?;
    let token = evm::parse_address(&req.token).map_err(|_| Refusal::TokenNotAllowed)?;
    let recipient = evm::parse_address(&req.recipient).map_err(|_| Refusal::RecipientNotAllowed)?;
    if !ctx.recipient_allowed {
        return Err(Refusal::RecipientNotAllowed);
    }
    let exact_transfer: Option<Address> = match (req.mode, &chain.exact_transfer) {
        (Mode::Exact, None) => return Err(Refusal::ModeNotAllowed),
        (Mode::Exact, Some(a)) => Some(evm::parse_address(a).map_err(|_| Refusal::ModeNotAllowed)?),
        (Mode::Direct, _) => None,
    };

    // The observation: complete, recent, and not straddling a unit change.
    let obs = &req.observed;
    let (new_multiplier, effective_at) = match (obs.new_multiplier, obs.effective_at) {
        (Some(n), Some(e)) => (n.0, e),
        _ => return Err(Refusal::ObservationIncomplete),
    };
    if obs.block_timestamp == 0 {
        return Err(Refusal::ObservationIncomplete);
    }
    if obs.block_timestamp > ctx.now_s.saturating_add(ctx.params.max_clock_skew_s) {
        return Err(Refusal::StaleObservation);
    }
    if ctx.now_s.saturating_sub(obs.block_timestamp) > ctx.params.max_observation_age_s {
        return Err(Refusal::StaleObservation);
    }
    let multiplier = obs.multiplier.0;
    if multiplier == 0 {
        return Err(Refusal::UnitUnavailable);
    }
    let change_scheduled = effective_at != 0 && new_multiplier != multiplier;
    if change_scheduled {
        // Observation predates a change that has already taken effect.
        // The reported multiplier is stale; fail closed. This rule is C1's
        // own: the SDK reads live and has no observation age to compare.
        if obs.block_timestamp < effective_at && effective_at <= ctx.now_s {
            return Err(Refusal::ObservationCrossedChange);
        }
        // Same predicate as `unitChangeImminent` in @shareexact/sdk and
        // `ShareExactGuard._corpActionImminent` for a complete observation.
        // Incomplete observations never reach here: they were refused above
        // with `ObservationIncomplete`, where the SDK may answer differently.
        // A change inside the window is refused so the agent cannot race a
        // corporate action.
        if effective_at > ctx.now_s && effective_at - ctx.now_s <= ctx.params.corp_action_window_s {
            return Err(Refusal::MultiplierChangePending);
        }
    }

    // How much. Same order as `ExactTransfer.transferShares`: zero request,
    // then shortfall, then a request that floored to nothing.
    let ui_shares = req.ui_shares.0;
    if ui_shares == 0 {
        return Err(Refusal::ZeroAmount);
    }
    let raw = math::shares_to_raw(ui_shares, multiplier).ok_or(Refusal::AmountCapExceeded)?;
    let delivered = math::raw_to_shares(raw, multiplier).ok_or(Refusal::AmountCapExceeded)?;
    let shortfall = ui_shares.saturating_sub(delivered);
    if shortfall > req.max_shortfall.0 {
        return Err(Refusal::ShareShortfall);
    }
    if raw == 0 {
        return Err(Refusal::ZeroAmount);
    }

    // Fees and gas, so a compromised agent key cannot drain gas money.
    let fees = &req.fees;
    if fees.max_priority_fee_per_gas.0 > fees.max_fee_per_gas.0 || fees.gas_limit.0 == 0 {
        return Err(Refusal::InvalidFees);
    }
    if fees.max_fee_per_gas.0 > chain.max_fee_per_gas.0
        || fees.max_priority_fee_per_gas.0 > chain.max_priority_fee_per_gas.0
        || fees.gas_limit.0 > chain.max_gas_limit.0
    {
        return Err(Refusal::GasCapExceeded);
    }

    // Build the exact call now: the replacement rule compares it byte for byte.
    let (to, input) = match exact_transfer {
        Some(et) => (
            et,
            evm::calldata_transfer_shares(&token, &recipient, ui_shares, req.max_shortfall.0),
        ),
        None => (token, evm::calldata_transfer(&recipient, raw)),
    };
    let tx = TxFields {
        chain_id: req.chain_id,
        nonce: fees.evm_nonce,
        to,
        input,
        gas_limit: fees.gas_limit.0,
        max_fee_per_gas: fees.max_fee_per_gas.0,
        max_priority_fee_per_gas: fees.max_priority_fee_per_gas.0,
    };

    // Nonce: the next fresh one, or a fee bump of the last signed call.
    let is_replacement = check_nonce(&tx, ctx)?;

    // Spend caps, in raw units and in shares. The raw amount is computed from
    // the agent's multiplier, so in Exact mode it can be understated; the
    // share amount is what Exact mode puts on chain. Checking both closes
    // that gap. A replacement re-signs a transfer already counted.
    if raw > token_policy.max_raw_per_request.0 || ui_shares > token_policy.max_shares_per_request.0
    {
        return Err(Refusal::AmountCapExceeded);
    }
    if !is_replacement
        && (ctx.spent_today.saturating_add(raw) > token_policy.max_raw_per_day.0
            || ctx.shares_spent_today.saturating_add(ui_shares) > token_policy.max_shares_per_day.0)
    {
        return Err(Refusal::AmountCapExceeded);
    }

    Ok(Approved {
        tx,
        ui_shares,
        raw,
        delivered_shares: delivered,
        is_replacement,
    })
}

/// Returns whether the transaction is a replacement of the last signed one.
pub fn check_nonce(tx: &TxFields, ctx: &Context) -> Result<bool, Refusal> {
    if tx.nonce == ctx.next_nonce {
        return Ok(false);
    }
    match ctx.last_signed {
        Some(last) if last.nonce == tx.nonce => {
            let same_call =
                last.to == evm::address_hex(&tx.to) && last.input_hash == input_hash(&tx.input);
            let higher_fees = tx.max_fee_per_gas > last.max_fee_per_gas.0
                && tx.max_priority_fee_per_gas > last.max_priority_fee_per_gas.0;
            if same_call && higher_fees {
                Ok(true)
            } else {
                Err(Refusal::InvalidReplacement)
            }
        }
        _ => Err(Refusal::NonceOutOfOrder),
    }
}

pub fn input_hash(input: &[u8]) -> String {
    evm::to_hex(&near_sdk::env::keccak256(input))
}

pub fn record_of(tx: &TxFields) -> SignedRecord {
    SignedRecord {
        nonce: tx.nonce,
        to: evm::address_hex(&tx.to),
        input_hash: input_hash(&tx.input),
        max_fee_per_gas: U128(tx.max_fee_per_gas),
        max_priority_fee_per_gas: U128(tx.max_priority_fee_per_gas),
    }
}
