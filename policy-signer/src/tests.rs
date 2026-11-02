//! Unit tests: every refusal, reservation and release, the replacement rule,
//! the approval queue, pause and nonce burn, owner controls, the upgrade
//! timelock, and EIP-1559 encoding against vectors produced independently by
//! viem (regenerate with `cd agent && npm run vectors`).

use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use policy::{Observation, TicketStatus};

const NOW_S: u64 = 1_793_318_400; // 2026-10-31T00:00:00Z
const CHAIN: u64 = 46_630;
const SELF: &str = "policy.shareexact.testnet";
const OWNER: &str = "owner.testnet";
const AGENT: &str = "agent.testnet";
const AGENT2: &str = "agent2.testnet";
/// StockExact in the default setup; the viem vectors use this address.
const TOKEN: &str = "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e";
const DIRECT: &str = "0x3333333333333333333333333333333333333333";
const PLAIN: &str = "0x2222222222222222222222222222222222222222";
const RECIPIENT: &str = "0x000000000000000000000000000000000000dead";
const STRANGER: &str = "0x1111111111111111111111111111111111111111";
const EXACT: &str = "0x8c726dc9d27902515f70596b7f07610f1bf4ecd2";
const WAD: u128 = math::WAD;
const MU_MULTIPLIER: u128 = 1_000_183_456_682_946_507;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, now_s: u64, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(SELF))
        .predecessor_account_id(acct(predecessor))
        .block_timestamp(now_s * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    b
}

fn as_owner_at(now_s: u64) {
    testing_env!(ctx(OWNER, now_s, 1).build());
}
fn as_owner() {
    as_owner_at(NOW_S);
}
fn as_at(who: &str, now_s: u64) {
    testing_env!(ctx(who, now_s, 0).build());
}
fn as_agent() {
    as_at(AGENT, NOW_S);
}

fn chain_policy(exact: Option<&str>) -> ChainPolicy {
    ChainPolicy {
        max_fee_per_gas: U128(100_000_000),
        max_priority_fee_per_gas: U128(10_000_000),
        max_gas_limit: U128(200_000),
        exact_transfer: exact.map(Into::into),
        unknown_recipients_need_approval: false,
    }
}

fn token_policy(kind: TokenKind, approval_above: Option<u128>) -> TokenPolicy {
    TokenPolicy {
        kind,
        max_per_request: U128(5 * WAD),
        max_per_day: U128(10 * WAD),
        approval_above: approval_above.map(U128),
    }
}

fn setup() -> PolicySigner {
    as_at(SELF, NOW_S);
    let mut c = PolicySigner::new(
        acct(OWNER),
        acct("v1.signer-prod.testnet"),
        "robinhood-46630-1".into(),
        Network::Testnet,
    );
    as_owner();
    c.set_chain(CHAIN, chain_policy(Some(EXACT)));
    c.set_token(
        CHAIN,
        TOKEN.into(),
        token_policy(TokenKind::StockExact, None),
    );
    c.set_token(
        CHAIN,
        DIRECT.into(),
        token_policy(TokenKind::StockDirect, None),
    );
    c.set_token(CHAIN, PLAIN.into(), token_policy(TokenKind::Plain, None));
    c.set_recipient(CHAIN, RECIPIENT.into(), true);
    for a in [AGENT, AGENT2] {
        c.add_agent(
            acct(a),
            AgentPolicy {
                enabled: true,
                label: a.into(),
                max_requests_per_day: 20,
            },
        );
    }
    c
}

fn obs(multiplier: u128) -> Observation {
    Observation {
        multiplier: U128(multiplier),
        new_multiplier: Some(U128(multiplier)),
        effective_at: Some(0),
        block_number: 1,
        block_timestamp: NOW_S - 10,
    }
}

fn req_for(token: &str, amount: u128, nonce: u64) -> TransferRequest {
    TransferRequest {
        chain_id: CHAIN,
        token: token.into(),
        recipient: RECIPIENT.into(),
        amount: U128(amount),
        max_shortfall: U128(0),
        observed: (token != PLAIN).then(|| obs(WAD)),
        fees: Fees {
            evm_nonce: nonce,
            gas_limit: U128(120_000),
            max_fee_per_gas: U128(40_348_000),
            max_priority_fee_per_gas: U128(1_000_000),
        },
        ticket_id: None,
    }
}

fn req(amount: u128, nonce: u64) -> TransferRequest {
    req_for(TOKEN, amount, nonce)
}

fn outcome_as(c: &mut PolicySigner, who: &str, r: TransferRequest) -> PromiseOrValue<Outcome> {
    as_at(who, NOW_S);
    c.request(r)
}

fn refusal_as(c: &mut PolicySigner, who: &str, r: TransferRequest) -> Refusal {
    match outcome_as(c, who, r) {
        PromiseOrValue::Value(Outcome::Refused { reason }) => reason,
        PromiseOrValue::Value(o) => panic!("expected a refusal, got {o:?}"),
        PromiseOrValue::Promise(_) => panic!("expected a refusal, got a sign call"),
    }
}

fn refusal(c: &mut PolicySigner, r: TransferRequest) -> Refusal {
    refusal_as(c, AGENT, r)
}

fn accepted_as(c: &mut PolicySigner, who: &str, r: TransferRequest) {
    match outcome_as(c, who, r) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(o) => panic!("expected a sign call, got {o:?}"),
    }
}

fn accepted(c: &mut PolicySigner, r: TransferRequest) {
    accepted_as(c, AGENT, r)
}

fn queued(c: &mut PolicySigner, r: TransferRequest) -> u64 {
    match outcome_as(c, AGENT, r) {
        PromiseOrValue::Value(Outcome::PendingApproval { ticket_id, .. }) => ticket_id,
        PromiseOrValue::Value(o) => panic!("expected a queued ticket, got {o:?}"),
        PromiseOrValue::Promise(_) => panic!("expected a queued ticket, got a sign call"),
    }
}

fn settle(c: &mut PolicySigner, request_id: u64, ok: bool) -> Outcome {
    // Called directly from Rust, `on_signed` takes its callback result as an
    // argument; on chain the generated wrapper fills it from the promise.
    as_at(SELF, NOW_S);
    let result = if ok {
        Ok(serde_json::from_str(
            r#"{"scheme":"Secp256k1","big_r":{"affine_point":"02aa"},"s":{"scalar":"bb"},"recovery_id":0}"#,
        )
        .unwrap())
    } else {
        Err(PromiseError::Failed)
    };
    c.on_signed(CHAIN, request_id, result)
}

fn sign_call_args() -> (Value, NearToken) {
    get_created_receipts()
        .iter()
        .flat_map(|rc| rc.actions.iter())
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } if method_name == b"sign" => {
                Some((serde_json::from_slice(args).unwrap(), *attached_deposit))
            }
            _ => None,
        })
        .expect("a sign call")
}

/* ------------------------------ refusals -------------------------------- */

#[test]
fn accepts_each_token_kind() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    accepted(&mut c, req_for(DIRECT, WAD, 1));
    settle(&mut c, 2, true);
    accepted(&mut c, req_for(PLAIN, WAD, 2));
}

#[test]
fn paused_refuses_requests() {
    let mut c = setup();
    as_owner();
    c.set_paused(true);
    assert_eq!(refusal(&mut c, req(WAD, 0)), Refusal::Paused);
    as_owner();
    c.set_paused(false);
    accepted(&mut c, req(WAD, 0));
}

#[test]
fn unknown_or_disabled_agent_is_refused_and_logged() {
    let mut c = setup();
    assert_eq!(
        refusal_as(&mut c, "stranger.testnet", req(WAD, 0)),
        Refusal::AgentNotAllowed
    );
    assert!(get_logs().iter().any(|l| l.contains("AgentNotAllowed")));
    as_owner();
    c.add_agent(
        acct(AGENT),
        AgentPolicy {
            enabled: false,
            label: "off".into(),
            max_requests_per_day: 20,
        },
    );
    assert_eq!(refusal(&mut c, req(WAD, 0)), Refusal::AgentNotAllowed);
    as_owner();
    c.remove_agent(acct(AGENT2));
    assert_eq!(
        refusal_as(&mut c, AGENT2, req(WAD, 0)),
        Refusal::AgentNotAllowed
    );
}

#[test]
fn request_caps_global_and_per_agent() {
    let mut c = setup();
    as_owner();
    c.add_agent(
        acct(AGENT),
        AgentPolicy {
            enabled: true,
            label: "a".into(),
            max_requests_per_day: 1,
        },
    );
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    assert_eq!(refusal(&mut c, req(WAD, 1)), Refusal::RequestCapExceeded);
    // The other agent still has room until the global cap.
    as_owner();
    c.set_params(Params {
        max_requests_per_day: 2,
        ..Params::default()
    });
    accepted_as(&mut c, AGENT2, req(WAD, 1));
    settle(&mut c, 2, true);
    assert_eq!(
        refusal_as(&mut c, AGENT2, req(WAD, 2)),
        Refusal::RequestCapExceeded
    );
}

#[test]
fn request_in_flight() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    assert_eq!(
        refusal_as(&mut c, AGENT2, req(WAD, 1)),
        Refusal::RequestInFlight
    );
}

#[test]
fn chain_token_recipient_allowlists() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.chain_id = 1;
    assert_eq!(refusal(&mut c, r), Refusal::ChainNotAllowed);
    assert_eq!(
        refusal(&mut c, req_for(STRANGER, WAD, 0)),
        Refusal::TokenNotAllowed
    );
    let mut r = req(WAD, 0);
    r.recipient = STRANGER.into();
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}

#[test]
fn malformed_addresses_are_refused_not_panicked() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.recipient = "not-an-address".into();
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
    // Audit F2: a multi-byte character used to panic inside the parser.
    let mut r = req(WAD, 0);
    r.recipient = format!("0x\u{e9}\u{e9}{}", "0".repeat(36));
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"refused\"")));
}

#[test]
fn exact_transfer_missing_after_chain_change() {
    let mut c = setup();
    as_owner();
    c.set_chain(CHAIN, chain_policy(None));
    assert_eq!(refusal(&mut c, req(WAD, 0)), Refusal::ExactTransferMissing);
    // Plain and Direct do not need it.
    accepted(&mut c, req_for(PLAIN, WAD, 0));
}

#[test]
fn observation_incomplete_fails_closed() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.observed = None;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().new_multiplier = None;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().effective_at = None;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().block_timestamp = 0;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
}

#[test]
fn plain_tokens_need_no_observation() {
    let mut c = setup();
    let mut r = req_for(PLAIN, WAD, 0);
    r.observed = None;
    accepted(&mut c, r);
}

#[test]
fn stale_observation_old_or_future() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().block_timestamp = NOW_S - 121;
    assert_eq!(refusal(&mut c, r), Refusal::StaleObservation);
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().block_timestamp = NOW_S + 16;
    assert_eq!(refusal(&mut c, r), Refusal::StaleObservation);
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().block_timestamp = NOW_S + 15;
    accepted(&mut c, r);
}

#[test]
fn unit_unavailable() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.observed = Some(obs(0));
    assert_eq!(refusal(&mut c, r), Refusal::UnitUnavailable);
}

#[test]
fn multiplier_change_pending_and_outside_window() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    let o = r.observed.as_mut().unwrap();
    o.new_multiplier = Some(U128(2 * WAD));
    o.effective_at = Some(NOW_S + 7_200);
    assert_eq!(refusal(&mut c, r.clone()), Refusal::MultiplierChangePending);
    r.observed.as_mut().unwrap().effective_at = Some(NOW_S + 7_201);
    accepted(&mut c, r);
}

#[test]
fn same_value_change_is_not_a_change() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.observed.as_mut().unwrap().effective_at = Some(NOW_S + 60);
    accepted(&mut c, r);
}

#[test]
fn observation_crossed_change() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    let o = r.observed.as_mut().unwrap();
    o.block_timestamp = NOW_S - 30;
    o.new_multiplier = Some(U128(2 * WAD));
    o.effective_at = Some(NOW_S - 5);
    assert_eq!(refusal(&mut c, r), Refusal::ObservationCrossedChange);
}

#[test]
fn zero_amount_and_floored_to_zero() {
    let mut c = setup();
    assert_eq!(refusal(&mut c, req(0, 0)), Refusal::ZeroAmount);
    assert_eq!(refusal(&mut c, req_for(PLAIN, 0, 0)), Refusal::ZeroAmount);
    let mut r = req(1, 0);
    r.observed = Some(obs(4 * WAD));
    r.max_shortfall = U128(1);
    assert_eq!(refusal(&mut c, r), Refusal::ZeroAmount);
}

#[test]
fn share_shortfall() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.observed = Some(obs(MU_MULTIPLIER));
    assert_eq!(refusal(&mut c, r.clone()), Refusal::ShareShortfall);
    r.max_shortfall = U128(1);
    accepted(&mut c, r);
}

#[test]
fn amount_overflow() {
    let mut c = setup();
    let mut r = req(u128::MAX / 2, 0);
    r.observed = Some(obs(1));
    assert_eq!(refusal(&mut c, r), Refusal::AmountOverflow);
}

#[test]
fn invalid_fees_and_gas_caps() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.fees.max_fee_per_gas = U128(100_000_001);
    assert_eq!(refusal(&mut c, r), Refusal::GasCapExceeded);
    let mut r = req(WAD, 0);
    r.fees.gas_limit = U128(200_001);
    assert_eq!(refusal(&mut c, r), Refusal::GasCapExceeded);
    let mut r = req(WAD, 0);
    r.fees.max_priority_fee_per_gas = U128(50_000_000);
    assert_eq!(refusal(&mut c, r), Refusal::InvalidFees);
    let mut r = req(WAD, 0);
    r.fees.gas_limit = U128(0);
    assert_eq!(refusal(&mut c, r), Refusal::InvalidFees);
}

#[test]
fn nonce_out_of_order() {
    let mut c = setup();
    assert_eq!(refusal(&mut c, req(WAD, 1)), Refusal::NonceOutOfOrder);
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    assert_eq!(refusal(&mut c, req(WAD, 5)), Refusal::NonceOutOfOrder);
}

#[test]
fn replacement_rules() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    assert_eq!(refusal(&mut c, req(WAD, 0)), Refusal::InvalidReplacement);
    let bump = |mut r: TransferRequest| {
        r.fees.max_fee_per_gas = U128(50_000_000);
        r.fees.max_priority_fee_per_gas = U128(2_000_000);
        r
    };
    assert_eq!(
        refusal(&mut c, bump(req(2 * WAD, 0))),
        Refusal::InvalidReplacement
    );
    accepted(&mut c, bump(req(WAD, 0)));
    settle(&mut c, 2, true);
    assert_eq!(
        c.get_spent_today(CHAIN, TOKEN.into()).0,
        WAD,
        "replacement not counted twice"
    );
    assert_eq!(c.get_nonce_state(CHAIN).next, 1);
}

/* ------------------- caps: one unit per token (audit F1) ------------------- */

#[test]
fn exact_tokens_count_shares_whatever_the_multiplier() {
    // The agent claims multiplier 100.0 for 6 shares (raw estimate 0.06).
    // Shares are what Exact mode puts on chain, so the share cap of 5 binds.
    let mut c = setup();
    let mut r = req(6 * WAD, 0);
    r.observed = Some(obs(100 * WAD));
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);
}

#[test]
fn direct_tokens_count_raw_whatever_the_multiplier() {
    // 1 share at a claimed multiplier of 0.1 is 10 raw. Raw is what Direct
    // mode moves, so the raw cap of 5 binds.
    let mut c = setup();
    let mut r = req_for(DIRECT, WAD, 0);
    r.observed = Some(obs(WAD / 10));
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);
}

#[test]
fn no_mode_switching_doubles_the_daily_bound() {
    // Audit F1: with one kind per token there is one budget per token. Fill
    // the Exact token's day, then try every trick: nothing more moves.
    let mut c = setup();
    for (n, id) in [(0u64, 1u64), (1, 2)] {
        accepted(&mut c, req(5 * WAD, n));
        settle(&mut c, id, true);
    }
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 10 * WAD);
    let mut r = req(WAD, 2);
    r.observed = Some(obs(1_000 * WAD));
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);
    // The same address cannot be sent as Direct: the kind belongs to the token.
    let preview = {
        as_agent();
        c.preview(acct(AGENT), req(WAD, 2))
    };
    assert_eq!(preview.cap_unit, None);
    assert_eq!(preview.refusal, Some(Refusal::AmountCapExceeded));
}

// One test per kind: the mocked blockchain keeps storage within a test.
fn caps_hold_for(token: &str) {
    let mut c = setup();
    assert_eq!(
        refusal(&mut c, req_for(token, 6 * WAD, 0)),
        Refusal::AmountCapExceeded
    );
    accepted(&mut c, req_for(token, 5 * WAD, 0));
    settle(&mut c, 1, true);
    accepted(&mut c, req_for(token, 5 * WAD, 1));
    settle(&mut c, 2, true);
    assert_eq!(
        refusal(&mut c, req_for(token, WAD, 2)),
        Refusal::AmountCapExceeded
    );
}

#[test]
fn caps_hold_for_stock_exact() {
    caps_hold_for(TOKEN);
}

#[test]
fn caps_hold_for_stock_direct() {
    caps_hold_for(DIRECT);
}

#[test]
fn caps_hold_for_plain() {
    caps_hold_for(PLAIN);
}

#[test]
fn agent_cap_binds_alongside_the_global_cap() {
    let mut c = setup();
    as_owner();
    c.set_agent_cap(acct(AGENT), CHAIN, TOKEN.into(), Some(U128(3 * WAD)));
    accepted(&mut c, req(3 * WAD, 0));
    settle(&mut c, 1, true);
    assert_eq!(refusal(&mut c, req(WAD, 1)), Refusal::AgentCapExceeded);
    // The second agent has no own cap; the global cap still has 7 left.
    accepted_as(&mut c, AGENT2, req(5 * WAD, 1));
    settle(&mut c, 2, true);
    assert_eq!(
        refusal_as(&mut c, AGENT2, req(3 * WAD, 2)),
        Refusal::AmountCapExceeded
    );
}

#[test]
fn daily_caps_reset_next_utc_day() {
    let mut c = setup();
    accepted(&mut c, req(5 * WAD, 0));
    settle(&mut c, 1, true);
    accepted(&mut c, req(5 * WAD, 1));
    settle(&mut c, 2, true);
    let tomorrow = NOW_S + 86_400;
    as_at(AGENT, tomorrow);
    let mut r = req(WAD, 2);
    r.observed.as_mut().unwrap().block_timestamp = tomorrow - 10;
    assert!(matches!(c.request(r), PromiseOrValue::Promise(_)));
}

/* --------------------------- approval queue ------------------------------- */

fn with_approval_above(c: &mut PolicySigner, soft: u128) {
    as_owner();
    c.set_token(
        CHAIN,
        TOKEN.into(),
        token_policy(TokenKind::StockExact, Some(soft)),
    );
}

#[test]
fn large_request_is_queued_then_signed_after_approval() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    accepted(&mut c, req(2 * WAD, 0)); // at the soft limit: no approval needed
    settle(&mut c, 1, true);

    let id = queued(&mut c, req(4 * WAD, 1));
    assert_eq!(c.get_ticket(id).unwrap().status, TicketStatus::Pending);
    assert_eq!(
        c.get_nonce_state(CHAIN).next,
        1,
        "queueing reserves nothing"
    );
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 2 * WAD);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"escalated\"")));

    // Without approval the ticket is useless.
    let mut r = req(4 * WAD, 1);
    r.ticket_id = Some(id);
    assert_eq!(refusal(&mut c, r.clone()), Refusal::TicketInvalid);

    as_owner();
    c.approve_ticket(id);
    accepted(&mut c, r.clone());
    assert!(c.get_ticket(id).is_none(), "consumed");
    settle(&mut c, 2, true);
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 6 * WAD);
    // Not reusable.
    r.fees.evm_nonce = 2;
    assert_eq!(refusal(&mut c, r), Refusal::TicketInvalid);
}

#[test]
fn ticket_must_match_agent_and_request() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    let id = queued(&mut c, req(4 * WAD, 0));
    as_owner();
    c.approve_ticket(id);
    let mut r = req(4 * WAD, 0);
    r.ticket_id = Some(id);
    assert_eq!(
        refusal_as(&mut c, AGENT2, r.clone()),
        Refusal::TicketInvalid
    );
    let mut other = r.clone();
    other.amount = U128(5 * WAD);
    assert_eq!(refusal(&mut c, other), Refusal::TicketInvalid);
    accepted(&mut c, r);
}

#[test]
fn approved_ticket_expires() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    let id = queued(&mut c, req(4 * WAD, 0));
    as_owner();
    c.approve_ticket(id);
    let later = NOW_S + 901;
    as_at(AGENT, later);
    let mut r = req(4 * WAD, 0);
    r.ticket_id = Some(id);
    r.observed.as_mut().unwrap().block_timestamp = later - 5;
    assert!(matches!(
        c.request(r),
        PromiseOrValue::Value(Outcome::Refused {
            reason: Refusal::TicketInvalid
        })
    ));
}

#[test]
fn rejected_ticket_is_gone() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    let id = queued(&mut c, req(4 * WAD, 0));
    as_owner();
    c.reject_ticket(id);
    assert!(c.get_ticket(id).is_none());
}

#[test]
fn after_a_failed_approved_send_the_retry_is_a_fee_bump() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    let id = queued(&mut c, req(4 * WAD, 0));
    as_owner();
    c.approve_ticket(id);
    let mut r = req(4 * WAD, 0);
    r.ticket_id = Some(id);
    accepted(&mut c, r.clone());
    settle(&mut c, 1, false);
    assert!(
        c.get_ticket(id).is_none(),
        "consumed; the retry needs no ticket"
    );
    r.ticket_id = None;
    r.fees.max_fee_per_gas = U128(50_000_000);
    r.fees.max_priority_fee_per_gas = U128(2_000_000);
    accepted(&mut c, r);
}

#[test]
fn direct_ticket_cannot_be_reused_for_more_raw() {
    // Audit M1: the owner approved 3 shares at multiplier 1.0 (3 raw). A
    // re-send claiming multiplier 0.6 would move 5 raw: refused.
    let mut c = setup();
    as_owner();
    c.set_token(
        CHAIN,
        DIRECT.into(),
        token_policy(TokenKind::StockDirect, Some(2 * WAD)),
    );
    let id = queued(&mut c, req_for(DIRECT, 3 * WAD, 0));
    assert_eq!(c.get_ticket(id).unwrap().cap_amount.0, 3 * WAD);
    as_owner();
    c.approve_ticket(id);
    let mut r = req_for(DIRECT, 3 * WAD, 0);
    r.ticket_id = Some(id);
    r.observed = Some(obs(WAD * 6 / 10));
    assert_eq!(refusal(&mut c, r.clone()), Refusal::TicketInvalid);
    r.observed = Some(obs(WAD));
    accepted(&mut c, r);
}

#[test]
fn only_the_same_agent_can_fee_bump() {
    // Audit L3.
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    let mut bump = req(WAD, 0);
    bump.fees.max_fee_per_gas = U128(50_000_000);
    bump.fees.max_priority_fee_per_gas = U128(2_000_000);
    assert_eq!(
        refusal_as(&mut c, AGENT2, bump.clone()),
        Refusal::InvalidReplacement
    );
    accepted(&mut c, bump);
}

#[test]
fn burn_fees_are_bounded() {
    // A stolen owner key must not spend the derived address's ETH on fees
    // through burns, which skip the policy delay.
    let mut c = setup();
    as_owner();
    let fees = Fees {
        evm_nonce: 0,
        gas_limit: U128(21_000),
        max_fee_per_gas: U128(300_000_001), // above 3x the 100_000_000 cap
        max_priority_fee_per_gas: U128(1),
    };
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.burn_nonce(CHAIN, fees)));
    assert!(r.is_err());
    as_owner();
    let big_gas = Fees {
        evm_nonce: 0,
        gas_limit: U128(50_001),
        max_fee_per_gas: U128(1),
        max_priority_fee_per_gas: U128(1),
    };
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.burn_nonce(CHAIN, big_gas)
    }));
    assert!(r.is_err());
}

#[test]
fn a_burn_can_outbid_a_transaction_signed_at_the_cap() {
    // Audit L4.
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.fees.max_fee_per_gas = U128(100_000_000);
    r.fees.max_priority_fee_per_gas = U128(10_000_000);
    accepted(&mut c, r);
    settle(&mut c, 1, true);
    as_owner();
    let fees = Fees {
        evm_nonce: 0,
        gas_limit: U128(21_000),
        max_fee_per_gas: U128(150_000_000),
        max_priority_fee_per_gas: U128(15_000_000),
    };
    assert!(matches!(
        c.burn_nonce(CHAIN, fees),
        PromiseOrValue::Promise(_)
    ));
}

#[test]
fn a_ticket_never_lifts_a_hard_cap() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    // 6 shares is above the hard per-request cap of 5: refused, not queued.
    assert_eq!(refusal(&mut c, req(6 * WAD, 0)), Refusal::AmountCapExceeded);
}

#[test]
fn queue_is_bounded_and_prunes_expired() {
    let mut c = setup();
    with_approval_above(&mut c, 2 * WAD);
    as_owner();
    c.set_params(Params {
        max_open_tickets: 2,
        ..Params::default()
    });
    queued(&mut c, req(3 * WAD, 0));
    queued(&mut c, req(4 * WAD, 0));
    assert_eq!(refusal(&mut c, req(5 * WAD, 0)), Refusal::QueueFull);
    // After the pending lifetime, expired tickets make room again.
    let later = NOW_S + 86_401;
    as_at(AGENT, later);
    let mut r = req(5 * WAD, 0);
    r.observed.as_mut().unwrap().block_timestamp = later - 5;
    assert!(matches!(
        c.request(r),
        PromiseOrValue::Value(Outcome::PendingApproval { .. })
    ));
    assert_eq!(c.list_tickets(None, None).len(), 1);
}

/* ------------------------- pause and nonce burn --------------------------- */

#[test]
fn callback_still_settles_while_paused() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    as_owner();
    c.set_paused(true);
    assert!(matches!(settle(&mut c, 1, true), Outcome::Signed { .. }));
}

fn burn_fees(nonce: u64) -> Fees {
    Fees {
        evm_nonce: nonce,
        gas_limit: U128(21_000),
        max_fee_per_gas: U128(90_000_000),
        max_priority_fee_per_gas: U128(9_000_000),
    }
}

#[test]
fn burn_voids_an_issued_signature_even_while_paused() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    as_owner();
    c.set_paused(true);
    as_owner();
    assert!(matches!(
        c.burn_nonce(CHAIN, burn_fees(0)),
        PromiseOrValue::Promise(_)
    ));
    let flight = c.get_nonce_state(CHAIN).in_flight.unwrap();
    assert_eq!(flight.nonce, 0);
    assert_eq!(flight.record.to, RECIPIENT, "burn goes to the burn address");
    assert_eq!(flight.record.input_hash, policy::input_hash(&[]));
    settle(&mut c, 2, true);
    let st = c.get_nonce_state(CHAIN);
    assert_eq!(st.next, 1, "burning an old nonce does not move next");
    assert_eq!(st.last_signed.unwrap().to, RECIPIENT);
}

#[test]
fn burn_at_next_advances_and_beyond_next_is_refused() {
    let mut c = setup();
    as_owner();
    let _ = c.burn_nonce(CHAIN, burn_fees(0));
    settle(&mut c, 1, true);
    assert_eq!(c.get_nonce_state(CHAIN).next, 1);
    as_owner();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.burn_nonce(CHAIN, burn_fees(5))
    }));
    assert!(r.is_err());
}

#[test]
fn agent_cannot_replace_a_burn() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    settle(&mut c, 1, true);
    as_owner();
    let _ = c.burn_nonce(CHAIN, burn_fees(0));
    settle(&mut c, 2, true);
    let mut r = req(WAD, 0);
    r.fees.max_fee_per_gas = U128(99_000_000);
    r.fees.max_priority_fee_per_gas = U128(9_500_000);
    assert_eq!(refusal(&mut c, r), Refusal::InvalidReplacement);
}

/* --------------------------- signing lifecycle --------------------------- */

#[test]
fn sign_call_carries_the_checked_sighash_and_deposit() {
    let mut c = setup();
    as_owner();
    c.set_sign_deposit(U128(5));
    let r = req(WAD, 0);
    as_agent();
    let preview = c.preview(acct(AGENT), r.clone());
    assert_eq!(preview.decision, "SIGN");
    accepted(&mut c, r);
    let (args, deposit) = sign_call_args();
    assert_eq!(
        args["request"]["payload_v2"]["Ecdsa"],
        preview.sighash.unwrap().trim_start_matches("0x")
    );
    assert_eq!(args["request"]["path"], "robinhood-46630-1");
    assert_eq!(args["request"]["domain_id"], 0);
    assert_eq!(deposit, NearToken::from_yoctonear(5));
}

#[test]
fn success_advances_nonce_and_returns_the_signature() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    match settle(&mut c, 1, true) {
        Outcome::Signed {
            nonce, signature, ..
        } => {
            assert_eq!(nonce, 0);
            assert_eq!(signature["recovery_id"], 0);
        }
        o => panic!("{o:?}"),
    }
    let st = c.get_nonce_state(CHAIN);
    assert_eq!(st.next, 1);
    assert!(st.in_flight.is_none());
}

#[test]
fn a_failed_signature_is_treated_as_possibly_signed() {
    // Audit M2: after an MPC timeout a late signature can still appear, so a
    // failure neither frees the nonce nor releases the budget.
    let mut c = setup();
    as_owner();
    c.set_agent_cap(acct(AGENT), CHAIN, TOKEN.into(), Some(U128(5 * WAD)));
    accepted(&mut c, req(5 * WAD, 0));
    assert!(matches!(
        settle(&mut c, 1, false),
        Outcome::SignFailed { .. }
    ));
    assert_eq!(c.get_nonce_state(CHAIN).next, 1);
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 5 * WAD);
    // A different call at the same nonce is refused.
    let mut other = req(WAD, 0);
    other.fees.max_fee_per_gas = U128(50_000_000);
    other.fees.max_priority_fee_per_gas = U128(2_000_000);
    assert_eq!(refusal(&mut c, other), Refusal::InvalidReplacement);
    // The identical call can be re-signed as a fee bump, at no extra budget.
    let mut bump = req(5 * WAD, 0);
    bump.fees.max_fee_per_gas = U128(50_000_000);
    bump.fees.max_priority_fee_per_gas = U128(2_000_000);
    accepted(&mut c, bump);
    settle(&mut c, 2, true);
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 5 * WAD);
}

#[test]
fn late_callback_after_clear_is_logged_and_changes_nothing() {
    let mut c = setup();
    accepted(&mut c, req(WAD, 0));
    as_owner();
    c.clear_in_flight(CHAIN);
    assert!(matches!(
        settle(&mut c, 1, true),
        Outcome::SignFailed { .. }
    ));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("late_callback") && l.contains("\"signed\":true")));
    assert_eq!(c.get_nonce_state(CHAIN).next, 0);
}

#[test]
fn events_carry_who_what_and_unit() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.recipient = STRANGER.into();
    refusal(&mut c, r);
    let line = get_logs()
        .into_iter()
        .find(|l| l.contains("refused"))
        .unwrap();
    for needle in [AGENT, STRANGER, &format!("\"amount\":\"{WAD}\"")] {
        assert!(line.contains(needle), "{needle} missing in {line}");
    }
    accepted(&mut c, req(WAD, 0));
    let line = get_logs()
        .into_iter()
        .find(|l| l.contains("\"event\":\"signing\""))
        .unwrap();
    for needle in [
        "\"cap_unit\":\"shares\"",
        "\"raw_is_estimate\":true",
        "\"kind\":\"StockExact\"",
    ] {
        assert!(line.contains(needle), "{needle} missing in {line}");
    }
}

#[test]
fn status_view_summarises_one_token() {
    let mut c = setup();
    accepted(&mut c, req(3 * WAD, 0));
    let s = c.get_status(CHAIN, Some(TOKEN.into()));
    assert_eq!(s.spent_today.0, 3 * WAD);
    assert_eq!(s.remaining_today.unwrap().0, 7 * WAD);
    assert_eq!(s.cap_unit.as_deref(), Some("shares"));
    assert_eq!(s.in_flight.unwrap().kind, "transfer");
    assert_eq!(s.requests_today, 1);
    // Unknown chain or token: nulls, no panic.
    let empty = c.get_status(999, Some("junk".into()));
    assert!(empty.token.is_none() && empty.chain.is_none());
}

/* ----------------------------- owner controls ---------------------------- */

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_need_one_yocto() {
    let mut c = setup();
    as_at(OWNER, NOW_S); // no deposit: a function-call key on the owner account
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "only the owner may do this")]
fn agent_cannot_change_policy() {
    let mut c = setup();
    testing_env!(ctx(AGENT, NOW_S, 1).build());
    c.set_recipient(CHAIN, STRANGER.into(), true);
}

#[test]
#[should_panic(expected = "only the owner may do this")]
fn contract_itself_is_not_the_owner() {
    let mut c = setup();
    testing_env!(ctx(SELF, NOW_S, 1).build());
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "new must be called by this account")]
fn init_is_private() {
    as_at("attacker.testnet", NOW_S);
    PolicySigner::new(
        acct(OWNER),
        acct("v1.signer-prod.testnet"),
        "p".into(),
        Network::Testnet,
    );
}

#[test]
#[should_panic(expected = "signer account does not match the network")]
fn signer_must_match_network() {
    as_at(SELF, NOW_S);
    PolicySigner::new(acct(OWNER), acct("v1.signer"), "p".into(), Network::Testnet);
}

#[test]
#[should_panic(expected = "mainnet chain on a testnet signer")]
fn mainnet_chain_is_never_allowlisted_on_testnet() {
    let mut c = setup();
    as_owner();
    c.set_chain(4663, chain_policy(None));
}

#[test]
#[should_panic(expected = "an agent must be a separate account")]
fn owner_cannot_be_an_agent() {
    let mut c = setup();
    as_owner();
    c.add_agent(
        acct(OWNER),
        AgentPolicy {
            enabled: true,
            label: "x".into(),
            max_requests_per_day: 1,
        },
    );
}

#[test]
#[should_panic(expected = "approval_above must be below max_per_request")]
fn soft_limit_must_be_below_hard_limit() {
    let mut c = setup();
    with_approval_above(&mut c, 5 * WAD);
}

#[test]
#[should_panic(expected = "StockExact needs exact_transfer on the chain")]
fn exact_token_needs_exact_transfer() {
    let mut c = setup();
    as_owner();
    c.set_chain(CHAIN, chain_policy(None));
    as_owner();
    c.set_token(
        CHAIN,
        STRANGER.into(),
        token_policy(TokenKind::StockExact, None),
    );
}

#[test]
#[should_panic(expected = "corp_action_window_s below the 600 s floor")]
fn window_floor_is_enforced() {
    let mut c = setup();
    as_owner();
    c.set_params(Params {
        corp_action_window_s: 599,
        ..Params::default()
    });
}

#[test]
fn owner_approve_targets_exact_transfer_and_spends_no_agent_budget() {
    let mut c = setup();
    as_owner();
    c.add_agent(
        acct(AGENT),
        AgentPolicy {
            enabled: true,
            label: "a".into(),
            max_requests_per_day: 1,
        },
    );
    as_owner();
    let _ = c.request_approve(CHAIN, TOKEN.into(), U128(10 * WAD), req(WAD, 0).fees);
    let flight = c.get_nonce_state(CHAIN).in_flight.unwrap();
    assert_eq!(flight.record.to, TOKEN);
    let expected = evm::calldata_approve(&evm::parse_address(EXACT).unwrap(), 10 * WAD);
    assert_eq!(flight.record.input_hash, policy::input_hash(&expected));
    settle(&mut c, 1, true);
    // Audit F5: the owner's approve does not use up the agent's requests.
    accepted(&mut c, req(WAD, 1));
}

#[test]
#[should_panic(expected = "approve is only for StockExact tokens")]
fn approve_only_for_exact_tokens() {
    let mut c = setup();
    as_owner();
    let _ = c.request_approve(CHAIN, PLAIN.into(), U128(WAD), req(WAD, 0).fees);
}

#[test]
fn ownership_transfer_needs_acceptance() {
    let mut c = setup();
    as_owner();
    c.propose_owner(acct("new-owner.testnet"));
    testing_env!(ctx("new-owner.testnet", NOW_S, 1).build());
    c.accept_owner();
    assert_eq!(c.get_config().owner, acct("new-owner.testnet"));
}

#[test]
#[should_panic(expected = "not the proposed owner")]
fn only_proposed_owner_can_accept() {
    let mut c = setup();
    as_owner();
    c.propose_owner(acct("new-owner.testnet"));
    testing_env!(ctx("someone.testnet", NOW_S, 1).build());
    c.accept_owner();
}

#[test]
#[should_panic(expected = "an agent cannot become the owner")]
fn an_agent_cannot_accept_ownership() {
    let mut c = setup();
    as_owner();
    c.propose_owner(acct("new-owner.testnet"));
    as_owner();
    c.add_agent(
        acct("new-owner.testnet"),
        AgentPolicy {
            enabled: true,
            label: "x".into(),
            max_requests_per_day: 1,
        },
    );
    testing_env!(ctx("new-owner.testnet", NOW_S, 1).build());
    c.accept_owner();
}

/* -------------------------------- upgrade -------------------------------- */

#[test]
fn upgrade_waits_for_the_delay_and_checks_the_hash() {
    let mut c = setup();
    let code = b"\0asm fake contract".to_vec();
    let hash = evm::to_hex(&env::sha256(&code));
    as_owner();
    c.propose_upgrade(hash.clone());
    assert!(get_logs().iter().any(|l| l.contains("upgrade_proposed")));

    as_owner();
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.apply_upgrade(Base64VecU8(code.clone()))
    }));
    assert!(early.is_err(), "before the delay");

    let later = NOW_S + Params::default().upgrade_delay_s;
    as_owner_at(later);
    c.propose_upgrade(hash);
    as_owner_at(later + Params::default().upgrade_delay_s);
    let wrong = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.apply_upgrade(Base64VecU8(b"other code".to_vec()))
    }));
    assert!(wrong.is_err(), "wrong code");
}

#[test]
fn upgrade_deploys_and_migrates_after_the_delay() {
    let mut c = setup();
    let code = b"\0asm fake contract".to_vec();
    as_owner();
    c.propose_upgrade(evm::to_hex(&env::sha256(&code)));
    as_owner_at(NOW_S + Params::default().upgrade_delay_s);
    let _ = c.apply_upgrade(Base64VecU8(code));
    let actions: Vec<_> = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .collect();
    assert!(actions
        .iter()
        .any(|a| matches!(a, near_sdk::mock::MockAction::DeployContract { .. })));
    assert!(c.get_config().pending_upgrade.is_none());
}

#[test]
#[should_panic(expected = "upgrades are disabled")]
fn disabled_upgrades_stay_disabled() {
    let mut c = setup();
    as_owner();
    c.propose_upgrade("ab".repeat(32));
    as_owner();
    c.disable_upgrades();
    assert!(c.get_config().upgrades_disabled);
    assert!(
        c.get_config().pending_upgrade.is_none(),
        "a pending upgrade is dropped"
    );
    as_owner();
    c.propose_upgrade("cd".repeat(32));
}

#[test]
#[should_panic(expected = "upgrade_delay_s below the 24 h floor")]
fn upgrade_delay_floor() {
    let mut c = setup();
    as_owner();
    c.set_params(Params {
        upgrade_delay_s: 3_600,
        ..Params::default()
    });
}

/* ------------------------- encoding: viem vectors ------------------------ */

#[test]
fn direct_transfer_matches_viem() {
    let mut c = setup();
    as_owner();
    c.set_token(
        CHAIN,
        TOKEN.into(),
        token_policy(TokenKind::StockDirect, None),
    );
    let mut r = req(WAD, 0);
    r.observed = Some(obs(MU_MULTIPLIER));
    r.max_shortfall = U128(1);
    as_agent();
    let p = c.preview(acct(AGENT), r);
    assert_eq!(
        p.unsigned_tx.unwrap(),
        "0x02f86e82b62680830f4240840267a9608301d4c094c9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e80b844\
         a9059cbb000000000000000000000000000000000000000000000000000000000000dead\
         0000000000000000000000000000000000000000000000000de00fe126add464c0"
    );
    assert_eq!(
        p.sighash.unwrap(),
        "0xd6bd87cccf2d404096fb7cdd9c10f99e4a330c4a5a7a9d94930e377196015c62"
    );
    assert_eq!(p.raw.unwrap().0, 999_816_576_967_234_660);
    assert!(!p.raw_is_estimate);
}

#[test]
fn exact_transfer_matches_viem() {
    let mut c = setup();
    as_owner();
    c.reset_nonce(CHAIN, 7);
    as_agent();
    let p = c.preview(acct(AGENT), req(WAD, 7));
    assert_eq!(p.to.unwrap(), EXACT);
    assert_eq!(
        p.unsigned_tx.unwrap(),
        "0x02f8ae82b62607830f4240840267a9608301d4c0948c726dc9d27902515f70596b7f07610f1bf4ecd280b884\
         a1774ea4000000000000000000000000c9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e\
         000000000000000000000000000000000000000000000000000000000000dead\
         0000000000000000000000000000000000000000000000000de0b6b3a7640000\
         0000000000000000000000000000000000000000000000000000000000000000c0"
    );
    assert_eq!(
        p.sighash.unwrap(),
        "0x2af050832cd51552e2244b0c10632b31e83b5d5f1bd148d9cfd57172798a8f87"
    );
    assert!(p.raw_is_estimate);
}

#[test]
fn preview_and_request_agree() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.recipient = STRANGER.into();
    as_agent();
    assert_eq!(
        c.preview(acct(AGENT), r.clone()).refusal,
        Some(Refusal::RecipientNotAllowed)
    );
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}

/* ------------------------------ native coin ------------------------------ */

const NATIVE_ADDR: &str = "0x0000000000000000000000000000000000000000";

fn with_native(c: &mut PolicySigner) {
    as_owner();
    c.set_token(
        CHAIN,
        NATIVE_ADDR.into(),
        token_policy(TokenKind::Native, None),
    );
}

#[test]
fn native_transfer_sends_value_with_empty_calldata() {
    let mut c = setup();
    with_native(&mut c);
    let mut r = req_for(NATIVE_ADDR, WAD / 100, 0);
    r.observed = None;
    as_agent();
    let p = c.preview(acct(AGENT), r.clone());
    assert_eq!(p.decision, "SIGN");
    assert_eq!(p.to.as_deref(), Some(RECIPIENT));
    assert_eq!(p.calldata.as_deref(), Some("0x"));
    assert_eq!(p.cap_unit.as_deref(), Some("wei"));
    accepted(&mut c, r);
    let flight = c.get_nonce_state(CHAIN).in_flight.unwrap();
    assert_eq!(flight.record.value.0, WAD / 100);
}

#[test]
fn native_caps_are_in_wei_and_value_is_part_of_the_replacement_rule() {
    let mut c = setup();
    with_native(&mut c);
    let mut r = req_for(NATIVE_ADDR, 6 * WAD, 0);
    r.observed = None;
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);
    let mut r = req_for(NATIVE_ADDR, WAD, 0);
    r.observed = None;
    accepted(&mut c, r.clone());
    settle(&mut c, 1, true);
    r.amount = U128(2 * WAD);
    r.fees.max_fee_per_gas = U128(50_000_000);
    r.fees.max_priority_fee_per_gas = U128(2_000_000);
    assert_eq!(refusal(&mut c, r), Refusal::InvalidReplacement);
}

#[test]
#[should_panic(expected = "Native uses the zero address, and only Native does")]
fn native_kind_needs_the_zero_address() {
    let mut c = setup();
    as_owner();
    c.set_token(
        CHAIN,
        STRANGER.into(),
        token_policy(TokenKind::Native, None),
    );
}

#[test]
#[should_panic(expected = "mainnet chain on a testnet signer")]
fn base_mainnet_is_blocked_on_testnet_too() {
    let mut c = setup();
    as_owner();
    c.set_chain(8453, chain_policy(None));
}

/* ---------------------------- policy delay ------------------------------- */

fn with_policy_delay(c: &mut PolicySigner, delay: u64) {
    as_owner();
    c.set_params(Params {
        policy_delay_s: delay,
        ..Params::default()
    });
}

#[test]
fn loosening_waits_for_the_policy_delay() {
    let mut c = setup();
    with_policy_delay(&mut c, 3_600);
    as_owner();
    c.set_recipient(CHAIN, STRANGER.into(), true);
    assert!(!c.is_recipient_allowed(CHAIN, STRANGER.into()), "not yet");
    let id = c.list_scheduled_changes()[0].id;
    assert!(get_logs().iter().any(|l| l.contains("change_scheduled")));

    as_owner();
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.execute_change(id)));
    assert!(early.is_err());

    as_owner_at(NOW_S + 3_600);
    c.execute_change(id);
    assert!(c.is_recipient_allowed(CHAIN, STRANGER.into()));
    assert!(get_logs().iter().any(|l| l.contains("policy_changed")));
}

#[test]
fn tightening_is_immediate_even_with_a_delay() {
    let mut c = setup();
    with_policy_delay(&mut c, 3_600);
    as_owner();
    c.set_recipient(CHAIN, RECIPIENT.into(), false);
    assert!(!c.is_recipient_allowed(CHAIN, RECIPIENT.into()));
    as_owner();
    c.remove_agent(acct(AGENT2));
    assert!(c.get_agent(acct(AGENT2)).is_none());
    as_owner();
    c.set_paused(true);
    assert!(c.get_config().paused);
}

#[test]
fn a_scheduled_change_can_be_cancelled_and_the_delay_itself_waits() {
    let mut c = setup();
    with_policy_delay(&mut c, 3_600);
    // Lowering the delay to zero is itself a scheduled change.
    with_policy_delay(&mut c, 0);
    assert_eq!(c.get_config().params.policy_delay_s, 3_600);
    let id = c.list_scheduled_changes()[0].id;
    as_owner();
    c.cancel_change(id);
    assert!(c.list_scheduled_changes().is_empty());
}

#[test]
fn every_policy_setter_emits_an_event() {
    let mut c = setup();
    let count = |name: &str| get_logs().iter().filter(|l| l.contains(name)).count();
    as_owner();
    c.set_chain(CHAIN, chain_policy(Some(EXACT)));
    assert_eq!(count("policy_changed"), 1);
    as_owner();
    c.set_sign_gas(60);
    assert_eq!(count("policy_changed"), 1);
    as_owner();
    c.remove_token(CHAIN, PLAIN.into());
    assert_eq!(count("token_removed"), 1);
    as_owner();
    c.reset_nonce(CHAIN, 3);
    assert_eq!(count("nonce_reset"), 1);
}

#[test]
#[should_panic(expected = "upgrade_delay_s can only be raised")]
fn upgrade_delay_cannot_be_lowered() {
    let mut c = setup();
    as_owner();
    c.set_params(Params {
        upgrade_delay_s: 86_400,
        ..Params::default()
    });
}

/* --------------------- new recipients and look-alikes -------------------- */

fn with_unknown_recipients_queued(c: &mut PolicySigner) {
    as_owner();
    c.set_chain(
        CHAIN,
        ChainPolicy {
            unknown_recipients_need_approval: true,
            ..chain_policy(Some(EXACT))
        },
    );
}

#[test]
fn a_new_recipient_goes_to_the_queue_when_the_chain_allows_it() {
    let mut c = setup();
    with_unknown_recipients_queued(&mut c);
    let mut r = req(WAD, 0);
    r.recipient = STRANGER.into();
    let id = queued(&mut c, r.clone());
    assert_eq!(c.get_ticket(id).unwrap().recipient, STRANGER);
    as_owner();
    c.approve_ticket(id);
    r.ticket_id = Some(id);
    accepted(&mut c, r);
    settle(&mut c, 1, true);
    // A one-off approval: the recipient is still not allowlisted.
    assert!(!c.is_recipient_allowed(CHAIN, STRANGER.into()));
    let mut again = req(WAD, 1);
    again.recipient = STRANGER.into();
    queued(&mut c, again);
}

#[test]
fn new_recipients_are_refused_by_default() {
    let mut c = setup();
    let mut r = req(WAD, 0);
    r.recipient = STRANGER.into();
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}

#[test]
fn a_lookalike_of_a_known_recipient_is_refused_even_with_the_queue_on() {
    // Address poisoning: same first and last four hex digits as the
    // allowlisted 0x0000...dead, different in the middle.
    let mut c = setup();
    with_unknown_recipients_queued(&mut c);
    let mut r = req(WAD, 0);
    r.recipient = "0x0000ffffffffffffffffffffffffffffffffdead".into();
    assert_eq!(refusal(&mut c, r), Refusal::LookalikeRecipient);
    assert!(get_logs().iter().any(|l| l.contains("LookalikeRecipient")));
}

#[test]
fn recipient_list_tracks_allow_and_remove() {
    let mut c = setup();
    assert_eq!(c.list_recipients(CHAIN), vec![RECIPIENT.to_string()]);
    as_owner();
    c.set_recipient(CHAIN, STRANGER.into(), true);
    as_owner();
    c.set_recipient(CHAIN, STRANGER.into(), true); // no duplicate
    assert_eq!(c.list_recipients(CHAIN).len(), 2);
    as_owner();
    c.set_recipient(CHAIN, RECIPIENT.into(), false);
    assert_eq!(c.list_recipients(CHAIN), vec![STRANGER.to_string()]);
    // Once removed, the old address no longer anchors look-alike checks.
    let mut r = req(WAD, 0);
    r.recipient = "0x0000ffffffffffffffffffffffffffffffffdead".into();
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}
