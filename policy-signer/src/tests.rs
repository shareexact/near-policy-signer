//! Unit tests: every refusal, the reservation and release logic, the
//! replacement rule, access control, and EIP-1559 encoding against vectors
//! produced independently by viem 2.21.0 (see `near/policy-signer/README.md`).

use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use policy::{Mode, Observation};

const NOW_S: u64 = 1_793_318_400; // 2026-10-31T00:00:00Z
const CHAIN: u64 = 46_630;
const TOKEN: &str = "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e";
const RECIPIENT: &str = "0x000000000000000000000000000000000000dead";
const STRANGER: &str = "0x1111111111111111111111111111111111111111";
const EXACT: &str = "0x8c726dc9d27902515f70596b7f07610f1bf4ecd2";
const WAD: u128 = math::WAD;
const MU_MULTIPLIER: u128 = 1_000_183_456_682_946_507;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, now_s: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct("policy.shareexact.testnet"))
        .predecessor_account_id(acct(predecessor))
        .block_timestamp(now_s * 1_000_000_000);
    b
}

fn as_owner(now_s: u64) {
    testing_env!(ctx("owner.testnet", now_s).build());
}

fn as_agent(now_s: u64) {
    testing_env!(ctx("agent.testnet", now_s).build());
}

fn setup() -> PolicySigner {
    as_owner(NOW_S);
    let mut c = PolicySigner::new(
        acct("owner.testnet"),
        acct("agent.testnet"),
        acct("v1.signer-prod.testnet"),
        "robinhood-46630-1".into(),
    );
    c.set_chain(
        CHAIN,
        ChainPolicy {
            max_fee_per_gas: U128(100_000_000),
            max_priority_fee_per_gas: U128(10_000_000),
            max_gas_limit: U128(200_000),
            exact_transfer: Some(EXACT.into()),
        },
    );
    c.set_token(
        CHAIN,
        TOKEN.into(),
        TokenPolicy {
            max_raw_per_request: U128(5 * WAD),
            max_raw_per_day: U128(10 * WAD),
            max_shares_per_request: U128(5 * WAD),
            max_shares_per_day: U128(10 * WAD),
        },
    );
    c.set_recipient(CHAIN, RECIPIENT.into(), true);
    c
}

fn req(mode: Mode, ui_shares: u128, nonce: u64) -> TransferRequest {
    TransferRequest {
        chain_id: CHAIN,
        token: TOKEN.into(),
        recipient: RECIPIENT.into(),
        ui_shares: U128(ui_shares),
        max_shortfall: U128(0),
        mode,
        observed: Observation {
            multiplier: U128(WAD),
            new_multiplier: Some(U128(WAD)),
            effective_at: Some(0),
            block_number: 1,
            block_timestamp: NOW_S - 10,
        },
        fees: Fees {
            evm_nonce: nonce,
            gas_limit: U128(120_000),
            max_fee_per_gas: U128(40_348_000),
            max_priority_fee_per_gas: U128(1_000_000),
        },
    }
}

fn refusal(c: &mut PolicySigner, r: TransferRequest) -> Refusal {
    as_agent(NOW_S);
    match c.request(r) {
        PromiseOrValue::Value(Outcome::Refused { reason }) => reason,
        PromiseOrValue::Value(o) => panic!("expected a refusal, got {o:?}"),
        PromiseOrValue::Promise(_) => panic!("expected a refusal, got a sign call"),
    }
}

fn accepted(c: &mut PolicySigner, r: TransferRequest) {
    as_agent(NOW_S);
    match c.request(r) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(o) => panic!("expected a sign call, got {o:?}"),
    }
}

fn settle(c: &mut PolicySigner, request_id: u64, ok: bool) -> Outcome {
    // Called directly from Rust, `on_signed` takes its callback result as an
    // argument; on chain the generated wrapper fills it from the promise.
    testing_env!(ctx("policy.shareexact.testnet", NOW_S).build());
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

/* ------------------------------- refusals ------------------------------- */

#[test]
fn accepts_a_valid_direct_transfer() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, WAD, 0));
}

#[test]
fn chain_not_allowed() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.chain_id = 1;
    assert_eq!(refusal(&mut c, r), Refusal::ChainNotAllowed);
}

#[test]
fn token_not_allowed() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.token = STRANGER.into();
    assert_eq!(refusal(&mut c, r), Refusal::TokenNotAllowed);
}

#[test]
fn recipient_not_allowed() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.recipient = STRANGER.into();
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}

#[test]
fn malformed_addresses_are_refused_not_panicked() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.recipient = "not-an-address".into();
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}

#[test]
fn mode_not_allowed_without_exact_transfer() {
    let mut c = setup();
    as_owner(NOW_S);
    c.set_chain(
        CHAIN,
        ChainPolicy {
            max_fee_per_gas: U128(100_000_000),
            max_priority_fee_per_gas: U128(10_000_000),
            max_gas_limit: U128(200_000),
            exact_transfer: None,
        },
    );
    assert_eq!(
        refusal(&mut c, req(Mode::Exact, WAD, 0)),
        Refusal::ModeNotAllowed
    );
}

#[test]
fn observation_incomplete_fails_closed() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.new_multiplier = None;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.effective_at = None;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.block_timestamp = 0;
    assert_eq!(refusal(&mut c, r), Refusal::ObservationIncomplete);
}

#[test]
fn stale_observation_old_or_future() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.block_timestamp = NOW_S - 121;
    assert_eq!(refusal(&mut c, r), Refusal::StaleObservation);
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.block_timestamp = NOW_S + 16;
    assert_eq!(refusal(&mut c, r), Refusal::StaleObservation);
    // Inside the age limit and the clock-skew allowance: accepted.
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.block_timestamp = NOW_S + 15;
    accepted(&mut c, r);
}

#[test]
fn unit_unavailable() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.multiplier = U128(0);
    assert_eq!(refusal(&mut c, r), Refusal::UnitUnavailable);
}

#[test]
fn multiplier_change_pending_inside_window() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.new_multiplier = Some(U128(2 * WAD));
    r.observed.effective_at = Some(NOW_S + 7_200);
    assert_eq!(refusal(&mut c, r), Refusal::MultiplierChangePending);
}

#[test]
fn change_outside_window_or_no_op_is_accepted() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.new_multiplier = Some(U128(2 * WAD));
    r.observed.effective_at = Some(NOW_S + 7_201);
    accepted(&mut c, r);

    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.new_multiplier = Some(U128(WAD)); // same value: nothing changes
    r.observed.effective_at = Some(NOW_S + 60);
    accepted(&mut c, r);
}

#[test]
fn observation_crossed_change() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.block_timestamp = NOW_S - 30;
    r.observed.new_multiplier = Some(U128(2 * WAD));
    r.observed.effective_at = Some(NOW_S - 5); // took effect after the reads
    assert_eq!(refusal(&mut c, r), Refusal::ObservationCrossedChange);
}

#[test]
fn zero_amount_and_floored_to_zero() {
    let mut c = setup();
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, 0, 0)),
        Refusal::ZeroAmount
    );
    // 1 wei of a share at multiplier 4.0 floors to 0 raw; with full
    // shortfall allowed it is reported as ZeroAmount, as ExactTransfer does.
    let mut r = req(Mode::Direct, 1, 0);
    r.observed.multiplier = U128(4 * WAD);
    r.observed.new_multiplier = Some(U128(4 * WAD));
    r.max_shortfall = U128(1);
    assert_eq!(refusal(&mut c, r), Refusal::ZeroAmount);
}

#[test]
fn share_shortfall() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.multiplier = U128(MU_MULTIPLIER);
    r.observed.new_multiplier = Some(U128(MU_MULTIPLIER));
    // floor(floor(1e18 * 1e18 / m) * m / 1e18) = 1e18 - 1 for MU's multiplier.
    assert_eq!(refusal(&mut c, r.clone()), Refusal::ShareShortfall);
    r.max_shortfall = U128(1);
    accepted(&mut c, r);
}

#[test]
fn amount_cap_per_request_and_per_day() {
    let mut c = setup();
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, 6 * WAD, 0)),
        Refusal::AmountCapExceeded
    );

    accepted(&mut c, req(Mode::Direct, 5 * WAD, 0));
    settle(&mut c, 1, true);
    accepted(&mut c, req(Mode::Direct, 5 * WAD, 1));
    settle(&mut c, 2, true);
    // 10 of 10 spent today.
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, WAD, 2)),
        Refusal::AmountCapExceeded
    );
}

#[test]
fn daily_cap_resets_next_utc_day() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, 5 * WAD, 0));
    settle(&mut c, 1, true);
    accepted(&mut c, req(Mode::Direct, 5 * WAD, 1));
    settle(&mut c, 2, true);

    let tomorrow = NOW_S + 86_400;
    as_agent(tomorrow);
    let mut r = req(Mode::Direct, WAD, 2);
    r.observed.block_timestamp = tomorrow - 10;
    assert!(matches!(c.request(r), PromiseOrValue::Promise(_)));
}

#[test]
fn gas_caps_and_invalid_fees() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.fees.max_fee_per_gas = U128(100_000_001);
    r.fees.max_priority_fee_per_gas = U128(1);
    assert_eq!(refusal(&mut c, r), Refusal::GasCapExceeded);
    let mut r = req(Mode::Direct, WAD, 0);
    r.fees.gas_limit = U128(200_001);
    assert_eq!(refusal(&mut c, r), Refusal::GasCapExceeded);
    let mut r = req(Mode::Direct, WAD, 0);
    r.fees.max_priority_fee_per_gas = U128(50_000_000); // above max_fee
    assert_eq!(refusal(&mut c, r), Refusal::InvalidFees);
    let mut r = req(Mode::Direct, WAD, 0);
    r.fees.gas_limit = U128(0);
    assert_eq!(refusal(&mut c, r), Refusal::InvalidFees);
}

#[test]
fn request_in_flight_blocks_a_second_request() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, WAD, 0));
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, WAD, 1)),
        Refusal::RequestInFlight
    );
}

#[test]
fn nonce_out_of_order() {
    let mut c = setup();
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, WAD, 1)),
        Refusal::NonceOutOfOrder
    );
    accepted(&mut c, req(Mode::Direct, WAD, 0));
    settle(&mut c, 1, true);
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, WAD, 5)),
        Refusal::NonceOutOfOrder
    );
}

#[test]
fn replacement_rules() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, WAD, 0));
    settle(&mut c, 1, true);

    // Same nonce, same call, fees not strictly higher.
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, WAD, 0)),
        Refusal::InvalidReplacement
    );

    // Same nonce, higher fees, different call.
    let mut r = req(Mode::Direct, 2 * WAD, 0);
    r.fees.max_fee_per_gas = U128(50_000_000);
    r.fees.max_priority_fee_per_gas = U128(2_000_000);
    assert_eq!(refusal(&mut c, r), Refusal::InvalidReplacement);

    // Same nonce, same call, both fees higher: accepted, and not counted
    // against the daily cap a second time.
    let mut r = req(Mode::Direct, WAD, 0);
    r.fees.max_fee_per_gas = U128(50_000_000);
    r.fees.max_priority_fee_per_gas = U128(2_000_000);
    accepted(&mut c, r);
    settle(&mut c, 2, true);
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, WAD);
    assert_eq!(c.get_nonce_state(CHAIN).next, 1);
}

#[test]
fn request_cap_exceeded() {
    let mut c = setup();
    as_owner(NOW_S);
    c.set_params(Params {
        max_requests_per_day: 1,
        ..Params::default()
    });
    accepted(&mut c, req(Mode::Direct, WAD, 0));
    settle(&mut c, 1, true);
    assert_eq!(
        refusal(&mut c, req(Mode::Direct, WAD, 1)),
        Refusal::RequestCapExceeded
    );
}

#[test]
fn refusals_are_logged_as_events() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.chain_id = 1;
    refusal(&mut c, r);
    let logs = get_logs();
    let line = logs
        .iter()
        .find(|l| l.contains("\"event\":\"refused\""))
        .expect("a refused event");
    assert!(line.contains("ChainNotAllowed"), "{line}");
    assert!(
        line.contains(&format!("\"recipient\":\"{RECIPIENT}\"")),
        "{line}"
    );
    assert!(line.contains(&format!("\"ui_shares\":\"{WAD}\"")), "{line}");
}

/* --------------------------- signing lifecycle --------------------------- */

#[test]
fn sign_call_carries_the_policy_checked_sighash() {
    let mut c = setup();
    let r = req(Mode::Direct, WAD, 0);
    as_agent(NOW_S);
    let preview = c.preview(r.clone());
    assert!(preview.accepted);
    accepted(&mut c, r);

    let receipts = get_created_receipts();
    let sign = receipts
        .iter()
        .flat_map(|rc| rc.actions.iter())
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } if method_name == b"sign" => Some((args.clone(), *attached_deposit)),
            _ => None,
        })
        .expect("a sign call");
    let args: Value = serde_json::from_slice(&sign.0).unwrap();
    let sighash = preview.sighash.unwrap();
    assert_eq!(
        args["request"]["payload_v2"]["Ecdsa"],
        sighash.trim_start_matches("0x")
    );
    assert_eq!(args["request"]["path"], "robinhood-46630-1");
    assert_eq!(args["request"]["domain_id"], 0);
    assert_eq!(sign.1, NearToken::from_yoctonear(1));
}

#[test]
fn success_advances_nonce_and_returns_the_signature() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, WAD, 0));
    match settle(&mut c, 1, true) {
        Outcome::Signed {
            nonce,
            signature,
            sighash,
            ..
        } => {
            assert_eq!(nonce, 0);
            assert_eq!(signature["recovery_id"], 0);
            assert!(sighash.starts_with("0x"));
        }
        o => panic!("{o:?}"),
    }
    let st = c.get_nonce_state(CHAIN);
    assert_eq!(st.next, 1);
    assert!(st.in_flight.is_none());
    assert_eq!(st.last_signed.unwrap().nonce, 0);
}

#[test]
fn failure_releases_nonce_and_budget() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, 5 * WAD, 0));
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 5 * WAD);
    assert!(matches!(
        settle(&mut c, 1, false),
        Outcome::SignFailed { .. }
    ));
    let st = c.get_nonce_state(CHAIN);
    assert_eq!(st.next, 0, "nonce 0 was never signed");
    assert!(st.in_flight.is_none());
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 0);
    // The same nonce can be used again.
    accepted(&mut c, req(Mode::Direct, 5 * WAD, 0));
}

#[test]
fn stale_callback_after_owner_clear_changes_nothing() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Direct, WAD, 0));
    as_owner(NOW_S);
    c.clear_in_flight(CHAIN);
    assert!(matches!(
        settle(&mut c, 1, true),
        Outcome::SignFailed { .. }
    ));
    assert_eq!(c.get_nonce_state(CHAIN).next, 0);
}

/* ---------------------------- access control ----------------------------- */

#[test]
#[should_panic(expected = "only the agent may request")]
fn only_the_agent_may_request() {
    let mut c = setup();
    as_owner(NOW_S);
    let _ = c.request(req(Mode::Direct, WAD, 0));
}

#[test]
#[should_panic(expected = "only the agent may request")]
fn the_contract_itself_may_not_request() {
    let mut c = setup();
    testing_env!(ctx("policy.shareexact.testnet", NOW_S).build());
    let _ = c.request(req(Mode::Direct, WAD, 0));
}

#[test]
#[should_panic(expected = "only the owner may do this")]
fn agent_cannot_change_policy() {
    let mut c = setup();
    as_agent(NOW_S);
    c.set_recipient(CHAIN, STRANGER.into(), true);
}

#[test]
#[should_panic(expected = "only the owner may do this")]
fn contract_itself_is_not_the_owner() {
    let mut c = setup();
    testing_env!(ctx("policy.shareexact.testnet", NOW_S).build());
    c.set_params(Params::default());
}

#[test]
#[should_panic(expected = "only the owner may do this")]
fn agent_cannot_request_an_approve() {
    let mut c = setup();
    as_agent(NOW_S);
    let _ = c.request_approve(
        CHAIN,
        TOKEN.into(),
        U128(WAD),
        req(Mode::Direct, WAD, 0).fees,
    );
}

#[test]
#[should_panic(expected = "owner must be a separate account")]
fn owner_cannot_be_the_contract() {
    as_owner(NOW_S);
    PolicySigner::new(
        acct("policy.shareexact.testnet"),
        acct("agent.testnet"),
        acct("v1.signer-prod.testnet"),
        "p".into(),
    );
}

#[test]
#[should_panic(expected = "mainnet chain on a testnet signer")]
fn mainnet_chain_is_never_allowlisted_on_testnet() {
    let mut c = setup();
    as_owner(NOW_S);
    c.set_chain(
        4663,
        ChainPolicy {
            max_fee_per_gas: U128(1),
            max_priority_fee_per_gas: U128(1),
            max_gas_limit: U128(1),
            exact_transfer: None,
        },
    );
}

#[test]
#[should_panic(expected = "corp_action_window_s below the 600 s floor")]
fn window_floor_is_enforced() {
    let mut c = setup();
    as_owner(NOW_S);
    c.set_params(Params {
        corp_action_window_s: 599,
        ..Params::default()
    });
}

/* ----------------------------- owner approve ----------------------------- */

#[test]
fn owner_approve_targets_exact_transfer_and_is_capped() {
    let mut c = setup();
    as_owner(NOW_S);
    let fees = req(Mode::Direct, WAD, 0).fees;
    match c.request_approve(CHAIN, TOKEN.into(), U128(11 * WAD), fees.clone()) {
        PromiseOrValue::Value(Outcome::Refused { reason }) => {
            assert_eq!(reason, Refusal::AmountCapExceeded)
        }
        _ => panic!("expected AmountCapExceeded"),
    }
    as_owner(NOW_S);
    assert!(matches!(
        c.request_approve(CHAIN, TOKEN.into(), U128(10 * WAD), fees),
        PromiseOrValue::Promise(_)
    ));
    let st = c.get_nonce_state(CHAIN);
    let flight = st.in_flight.unwrap();
    assert_eq!(flight.record.to, TOKEN);
    let expected = evm::calldata_approve(&evm::parse_address(EXACT).unwrap(), 10 * WAD);
    assert_eq!(flight.record.input_hash, policy::input_hash(&expected));
}

/* ------------------------- encoding: viem vectors ------------------------ */

#[test]
fn direct_transfer_matches_viem() {
    let c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.observed.multiplier = U128(MU_MULTIPLIER);
    r.observed.new_multiplier = Some(U128(MU_MULTIPLIER));
    r.max_shortfall = U128(1);
    as_agent(NOW_S);
    let p = c.preview(r);
    assert_eq!(
        p.calldata.unwrap(),
        "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead\
         0000000000000000000000000000000000000000000000000de00fe126add464"
    );
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
}

#[test]
fn exact_transfer_matches_viem() {
    let mut c = setup();
    // Bring the chain to nonce 7 so the vector's nonce is the next fresh one.
    as_owner(NOW_S);
    c.reset_nonce(CHAIN, 7);
    as_agent(NOW_S);
    let p = c.preview(req(Mode::Exact, WAD, 7));
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
}

#[test]
fn preview_and_request_agree() {
    let mut c = setup();
    let mut r = req(Mode::Direct, WAD, 0);
    r.recipient = STRANGER.into();
    as_agent(NOW_S);
    assert_eq!(
        c.preview(r.clone()).refusal,
        Some(Refusal::RecipientNotAllowed)
    );
    assert_eq!(refusal(&mut c, r), Refusal::RecipientNotAllowed);
}

/* ------------------------- share caps (Exact mode) ------------------------ */

#[test]
fn false_multiplier_cannot_bypass_caps_in_exact_mode() {
    // Agent claims multiplier 100.0 and asks for 400 shares. C1's raw estimate
    // is 4 (under the raw cap), but Exact mode puts 400 shares on chain. The
    // share cap catches it.
    let mut c = setup();
    let mut r = req(Mode::Exact, 400 * WAD, 0);
    r.observed.multiplier = U128(100 * WAD);
    r.observed.new_multiplier = Some(U128(100 * WAD));
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);
}

#[test]
fn share_cap_per_request_and_per_day() {
    let mut c = setup();
    // 6 shares at multiplier 2.0 is 3 raw: under the raw cap, over the share cap.
    let mut r = req(Mode::Exact, 6 * WAD, 0);
    r.observed.multiplier = U128(2 * WAD);
    r.observed.new_multiplier = Some(U128(2 * WAD));
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);

    // 5 + 5 shares at 2.0 (5 raw in total) fill the daily share cap.
    for (nonce, id) in [(0u64, 1u64), (1, 2)] {
        let mut r = req(Mode::Exact, 5 * WAD, nonce);
        r.observed.multiplier = U128(2 * WAD);
        r.observed.new_multiplier = Some(U128(2 * WAD));
        accepted(&mut c, r);
        settle(&mut c, id, true);
    }
    assert_eq!(c.get_shares_spent_today(CHAIN, TOKEN.into()).0, 10 * WAD);
    assert_eq!(c.get_spent_today(CHAIN, TOKEN.into()).0, 5 * WAD);
    let mut r = req(Mode::Exact, WAD, 2);
    r.observed.multiplier = U128(2 * WAD);
    r.observed.new_multiplier = Some(U128(2 * WAD));
    assert_eq!(refusal(&mut c, r), Refusal::AmountCapExceeded);
}

#[test]
fn failure_releases_reserved_shares() {
    let mut c = setup();
    accepted(&mut c, req(Mode::Exact, 5 * WAD, 0));
    assert_eq!(c.get_shares_spent_today(CHAIN, TOKEN.into()).0, 5 * WAD);
    settle(&mut c, 1, false);
    assert_eq!(c.get_shares_spent_today(CHAIN, TOKEN.into()).0, 0);
}

#[test]
#[should_panic(expected = "per-request cap above daily cap")]
fn share_caps_must_be_ordered() {
    let mut c = setup();
    as_owner(NOW_S);
    c.set_token(
        CHAIN,
        TOKEN.into(),
        TokenPolicy {
            max_raw_per_request: U128(1),
            max_raw_per_day: U128(1),
            max_shares_per_request: U128(2),
            max_shares_per_day: U128(1),
        },
    );
}
