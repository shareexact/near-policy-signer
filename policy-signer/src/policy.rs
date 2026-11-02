//! The policy decision, as a pure function of stored policy, the request and
//! the current time. `request` and `preview` both call it, so a preview can
//! never disagree with what a request would do.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::evm::{self, TxFields};
use crate::math;

/// Every reason the contract refuses to ask for a signature. Where a refusal
/// means the same condition as a ShareExact contract error, it carries the
/// same name (`MultiplierChangePending`, `UnitUnavailable`, `ShareShortfall`,
/// `ZeroAmount`), so no caller has to translate.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Paused,
    AgentNotAllowed,
    RequestCapExceeded,
    RequestInFlight,
    ChainNotAllowed,
    TokenNotAllowed,
    RecipientNotAllowed,
    ExactTransferMissing,
    ObservationIncomplete,
    StaleObservation,
    UnitUnavailable,
    ObservationCrossedChange,
    MultiplierChangePending,
    ZeroAmount,
    ShareShortfall,
    AmountOverflow,
    InvalidFees,
    GasCapExceeded,
    NonceOutOfOrder,
    InvalidReplacement,
    AmountCapExceeded,
    AgentCapExceeded,
    TicketInvalid,
    QueueFull,
}

/// What a token is, and therefore which amount is the trustworthy one.
///
/// Each token has exactly one kind, chosen by the owner, and one budget in
/// one unit. The unit is always the amount that appears in the signed
/// calldata, so no value supplied by the agent can shrink what is counted.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    /// Any ERC-20. Amounts and caps are raw units. Plain `transfer`.
    Plain,
    /// A Stock Token sent through ShareExact `ExactTransfer.transferShares`.
    /// Amounts and caps are shares (18 decimals); the EVM converts shares to
    /// raw units at execution with the live multiplier.
    StockExact,
    /// A Stock Token sent with a plain `transfer`. The request is in shares,
    /// the contract converts with the observed multiplier, and caps are raw
    /// units, because raw is what the calldata moves.
    StockDirect,
}

impl TokenKind {
    pub fn cap_unit(&self) -> &'static str {
        match self {
            TokenKind::StockExact => "shares",
            TokenKind::Plain | TokenKind::StockDirect => "raw",
        }
    }

    pub fn is_stock(&self) -> bool {
        !matches!(self, TokenKind::Plain)
    }
}

/// What the agent read from a Stock Token, at which block.
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
    /// Shares (18 decimals) for Stock Tokens; raw units for plain tokens.
    pub amount: U128,
    /// Stock Tokens only: shares the requester accepts losing to floor
    /// rounding, 18 decimals. Ignored for plain tokens.
    pub max_shortfall: U128,
    /// Required for Stock Tokens, ignored for plain tokens.
    pub observed: Option<Observation>,
    pub fees: Fees,
    /// Set when re-sending a request the owner approved through the queue.
    pub ticket_id: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ChainPolicy {
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub max_gas_limit: U128,
    /// ShareExact `ExactTransfer` on this chain. Required by `StockExact` tokens.
    pub exact_transfer: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TokenPolicy {
    pub kind: TokenKind,
    /// Caps in the token's unit (see `TokenKind`).
    pub max_per_request: U128,
    pub max_per_day: U128,
    /// Amounts strictly above this need the owner's approval through the
    /// queue. `None` means no approval step.
    pub approval_above: Option<U128>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AgentPolicy {
    pub enabled: bool,
    pub label: String,
    pub max_requests_per_day: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Params {
    /// Oldest observation accepted, seconds.
    pub max_observation_age_s: u64,
    /// How far an observation may sit ahead of NEAR's clock, seconds.
    pub max_clock_skew_s: u64,
    /// Seconds before a scheduled multiplier change in which transfers are
    /// refused. Floor 600, same as `ShareExactGuard.MIN_CORP_ACTION_WINDOW`.
    pub corp_action_window_s: u64,
    /// Requests accepted per UTC day across all agents.
    pub max_requests_per_day: u32,
    /// How long a queued request waits for the owner, seconds.
    pub pending_ticket_ttl_s: u64,
    /// How long an approved ticket stays usable, seconds.
    pub approved_ticket_ttl_s: u64,
    /// Open tickets kept at once. Bounds storage.
    pub max_open_tickets: u32,
    /// Delay between proposing and applying a code upgrade, seconds.
    pub upgrade_delay_s: u64,
}

pub const MIN_CORP_ACTION_WINDOW_S: u64 = 600;
pub const MIN_UPGRADE_DELAY_S: u64 = 86_400;
pub const MAX_OPEN_TICKETS_LIMIT: u32 = 100;

impl Default for Params {
    fn default() -> Self {
        Self {
            max_observation_age_s: 120,
            max_clock_skew_s: 15,
            corp_action_window_s: 7_200,
            max_requests_per_day: 50,
            pending_ticket_ttl_s: 86_400,
            approved_ticket_ttl_s: 900,
            max_open_tickets: 20,
            upgrade_delay_s: 172_800,
        }
    }
}

/// The last transaction signed on a chain: the only one an agent may re-sign,
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

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TicketStatus {
    Pending,
    Approved,
}

/// A request above `approval_above`, waiting for or holding the owner's approval.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Ticket {
    pub id: u64,
    pub agent: AccountId,
    pub chain_id: u64,
    pub token: String,
    pub recipient: String,
    pub amount: U128,
    pub status: TicketStatus,
    pub created_at: u64,
    pub expires_at: u64,
}

/// Everything the policy needs to see about stored state for one request.
pub struct Context<'a> {
    pub now_s: u64,
    pub params: &'a Params,
    pub paused: bool,
    pub agent: Option<&'a AgentPolicy>,
    pub agent_requests_today: u32,
    pub requests_today: u32,
    pub chain: Option<&'a ChainPolicy>,
    pub token: Option<&'a TokenPolicy>,
    pub recipient_allowed: bool,
    /// Spent today on this (chain, token), in the token's unit.
    pub spent_today: u128,
    /// The agent's own daily cap on this token, if the owner set one.
    pub agent_cap: Option<u128>,
    pub agent_spent_today: u128,
    pub in_flight: bool,
    pub next_nonce: u64,
    pub last_signed: Option<&'a SignedRecord>,
    pub ticket: Option<&'a Ticket>,
    pub caller: &'a AccountId,
}

/// An accepted request, ready to sign.
#[derive(Clone, Debug)]
pub struct Approved {
    pub tx: TxFields,
    pub kind: TokenKind,
    /// The amount counted against caps, in the token's unit.
    pub cap_amount: u128,
    /// Raw units leaving the derived address. Exact for `Plain` and
    /// `StockDirect`; an estimate from the observation for `StockExact`.
    pub raw: u128,
    /// Shares delivered after flooring; 0 for plain tokens.
    pub delivered_shares: u128,
    pub is_replacement: bool,
    pub ticket_id: Option<u64>,
}

#[derive(Clone, Debug)]
pub enum Decision {
    Sign(Approved),
    /// Within every hard cap but above `approval_above`: queue for the owner.
    NeedsApproval {
        cap_amount: u128,
    },
}

pub fn evaluate(req: &TransferRequest, ctx: &Context) -> Result<Decision, Refusal> {
    // Gates that do not depend on the request.
    if ctx.paused {
        return Err(Refusal::Paused);
    }
    let agent = ctx
        .agent
        .filter(|a| a.enabled)
        .ok_or(Refusal::AgentNotAllowed)?;
    if ctx.requests_today >= ctx.params.max_requests_per_day
        || ctx.agent_requests_today >= agent.max_requests_per_day
    {
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
    let kind = token_policy.kind;
    let exact_transfer = match kind {
        TokenKind::StockExact => Some(
            chain
                .exact_transfer
                .as_deref()
                .and_then(|a| evm::parse_address(a).ok())
                .ok_or(Refusal::ExactTransferMissing)?,
        ),
        _ => None,
    };

    // How much, and in which unit.
    let amount = req.amount.0;
    if amount == 0 {
        return Err(Refusal::ZeroAmount);
    }
    let (raw, delivered) = if kind.is_stock() {
        let multiplier = check_observation(req.observed.as_ref(), ctx)?;
        // Same order as `ExactTransfer.transferShares`: shortfall, then a
        // request that floored to nothing.
        let raw = math::shares_to_raw(amount, multiplier).ok_or(Refusal::AmountOverflow)?;
        let delivered = math::raw_to_shares(raw, multiplier).ok_or(Refusal::AmountOverflow)?;
        if amount.saturating_sub(delivered) > req.max_shortfall.0 {
            return Err(Refusal::ShareShortfall);
        }
        if raw == 0 {
            return Err(Refusal::ZeroAmount);
        }
        (raw, delivered)
    } else {
        (amount, 0)
    };
    let cap_amount = match kind {
        TokenKind::StockExact => amount,
        TokenKind::Plain | TokenKind::StockDirect => raw,
    };

    // Fees and gas, so a compromised agent key cannot drain gas money.
    check_fees(&req.fees, chain)?;

    // Build the exact call now: the replacement rule compares it byte for byte.
    let input = match exact_transfer {
        Some(_) => evm::calldata_transfer_shares(&token, &recipient, amount, req.max_shortfall.0),
        None => evm::calldata_transfer(&recipient, raw),
    };
    let tx = TxFields {
        chain_id: req.chain_id,
        nonce: req.fees.evm_nonce,
        to: exact_transfer.unwrap_or(token),
        input,
        gas_limit: req.fees.gas_limit.0,
        max_fee_per_gas: req.fees.max_fee_per_gas.0,
        max_priority_fee_per_gas: req.fees.max_priority_fee_per_gas.0,
    };
    let is_replacement = check_nonce(&tx, ctx.next_nonce, ctx.last_signed)?;

    // Caps, in the token's single unit. A replacement re-signs a transfer
    // already counted, so only the per-request cap applies to it.
    if cap_amount > token_policy.max_per_request.0 {
        return Err(Refusal::AmountCapExceeded);
    }
    if !is_replacement {
        if ctx.spent_today.saturating_add(cap_amount) > token_policy.max_per_day.0 {
            return Err(Refusal::AmountCapExceeded);
        }
        if let Some(cap) = ctx.agent_cap {
            if ctx.agent_spent_today.saturating_add(cap_amount) > cap {
                return Err(Refusal::AgentCapExceeded);
            }
        }
    }

    // Human approval for large amounts. A replacement was already approved
    // when it was first signed.
    let mut ticket_id = None;
    let needs_approval = token_policy
        .approval_above
        .map(|soft| cap_amount > soft.0)
        .unwrap_or(false);
    if needs_approval && !is_replacement {
        match req.ticket_id {
            None => return Ok(Decision::NeedsApproval { cap_amount }),
            Some(id) => {
                let t = ctx.ticket.ok_or(Refusal::TicketInvalid)?;
                let matches = t.id == id
                    && &t.agent == ctx.caller
                    && t.status == TicketStatus::Approved
                    && ctx.now_s < t.expires_at
                    && t.chain_id == req.chain_id
                    && t.token == evm::address_hex(&token)
                    && t.recipient == evm::address_hex(&recipient)
                    && t.amount.0 == amount;
                if !matches {
                    return Err(Refusal::TicketInvalid);
                }
                ticket_id = Some(id);
            }
        }
    }

    Ok(Decision::Sign(Approved {
        tx,
        kind,
        cap_amount,
        raw,
        delivered_shares: delivered,
        is_replacement,
        ticket_id,
    }))
}

/// Checks a Stock Token observation and returns the multiplier to use.
fn check_observation(obs: Option<&Observation>, ctx: &Context) -> Result<u128, Refusal> {
    let obs = obs.ok_or(Refusal::ObservationIncomplete)?;
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
    if effective_at != 0 && new_multiplier != multiplier {
        // The observation predates a change that has already taken effect, so
        // the reported multiplier is stale. This rule is the contract's own:
        // the SDK reads live and has no observation age to compare.
        if obs.block_timestamp < effective_at && effective_at <= ctx.now_s {
            return Err(Refusal::ObservationCrossedChange);
        }
        // Same predicate as `unitChangeImminent` in @shareexact/sdk and
        // `ShareExactGuard._corpActionImminent` for a complete observation.
        if effective_at > ctx.now_s && effective_at - ctx.now_s <= ctx.params.corp_action_window_s {
            return Err(Refusal::MultiplierChangePending);
        }
    }
    Ok(multiplier)
}

pub fn check_fees(fees: &Fees, chain: &ChainPolicy) -> Result<(), Refusal> {
    if fees.max_priority_fee_per_gas.0 > fees.max_fee_per_gas.0 || fees.gas_limit.0 == 0 {
        return Err(Refusal::InvalidFees);
    }
    if fees.max_fee_per_gas.0 > chain.max_fee_per_gas.0
        || fees.max_priority_fee_per_gas.0 > chain.max_priority_fee_per_gas.0
        || fees.gas_limit.0 > chain.max_gas_limit.0
    {
        return Err(Refusal::GasCapExceeded);
    }
    Ok(())
}

/// Returns whether the transaction is a replacement of the last signed one.
pub fn check_nonce(
    tx: &TxFields,
    next_nonce: u64,
    last: Option<&SignedRecord>,
) -> Result<bool, Refusal> {
    if tx.nonce == next_nonce {
        return Ok(false);
    }
    match last {
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
