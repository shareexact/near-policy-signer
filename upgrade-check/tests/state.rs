//! Upgrade rehearsal at the state level. The deployed code (`policy_signer_old`)
//! is set up the way the testnet deployment is, with a queued ticket, a spend
//! and a signed nonce; its state is written to storage; then the current code's
//! `migrate` reads it, as `apply_upgrade` does on chain, and every view must
//! return the same JSON. Finally the current code is exercised on that state.

use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, NearToken};
use serde_json::{json, Value};

use policy_signer as new;
use policy_signer_old as old;

const NOW_S: u64 = 1_793_660_000; // 2026-11-02, during the testnet run
const SELF: &str = "policy-v1.shareexact-chainsig-demo.testnet";
const OWNER: &str = "aa5hr.testnet";
const AGENT: &str = "agent-v1.shareexact-chainsig-demo.testnet";
const CHAIN: u64 = 46_630;
const ETH: &str = "0x0000000000000000000000000000000000000000";
const ALICE: &str = "0x0c7f5b0f2cba6a576f92f60205e87f4d28080490";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn at(who: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(SELF))
        .predecessor_account_id(acct(who))
        .block_timestamp(NOW_S * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}
fn j<T: near_sdk::serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap()
}

/// The deployed code, configured as on Nov 2 (DEPLOYMENT-TESTNET.md rows 6 and 11 to 14).
fn old_deployment() -> old::PolicySigner {
    use old::policy::*;
    at(SELF, 0);
    let mut c = old::PolicySigner::new(acct(OWNER), acct("v1.signer-prod.testnet"), "robinhood-46630-1".into(), old::Network::Testnet);
    at(OWNER, 1);
    c.add_agent(acct(AGENT), AgentPolicy { enabled: true, label: "demo agent".into(), max_requests_per_day: 20 });
    at(OWNER, 1);
    c.set_chain(
        CHAIN,
        ChainPolicy {
            max_fee_per_gas: U128(1_000_000_000),
            max_priority_fee_per_gas: U128(100_000_000),
            max_gas_limit: U128(200_000),
            exact_transfer: None,
            unknown_recipients_need_approval: true,
        },
    );
    at(OWNER, 1);
    c.set_token(
        CHAIN,
        ETH.into(),
        TokenPolicy { kind: TokenKind::Native, max_per_request: U128(1_000_000_000_000_000), max_per_day: U128(5_000_000_000_000_000), approval_above: Some(U128(500_000_000_000_000)) },
    );
    at(OWNER, 1);
    c.set_recipient(CHAIN, ALICE.into(), true);
    // The state after two signed transfers: next nonce 2.
    at(OWNER, 1);
    c.reset_nonce(CHAIN, 2);
    // A transfer above the soft limit: queued as ticket 1.
    at(AGENT, 0);
    let req = TransferRequest {
        chain_id: CHAIN,
        token: ETH.into(),
        recipient: ALICE.into(),
        amount: U128(800_000_000_000_000),
        max_shortfall: U128(0),
        observed: None,
        fees: Fees { evm_nonce: 2, gas_limit: U128(120_000), max_fee_per_gas: U128(40_000_000), max_priority_fee_per_gas: U128(1_000_000) },
        ticket_id: None,
    };
    let _ = c.request(req);
    c
}

fn views_old(c: &old::PolicySigner) -> Value {
    json!({
        "config": j(c.get_config()),
        "status": j(c.get_status(CHAIN, Some(ETH.into()))),
        "chain": j(c.get_chain(CHAIN)),
        "token": j(c.get_token(CHAIN, ETH.into())),
        "recipients": j(c.list_recipients(CHAIN)),
        "agent": j(c.get_agent(acct(AGENT))),
        "tickets": j(c.list_tickets(None, None)),
        "nonce": j(c.get_nonce_state(CHAIN)),
        "scheduled": j(c.list_scheduled_changes()),
    })
}
fn views_new(c: &new::PolicySigner) -> Value {
    json!({
        "config": j(c.get_config()),
        "status": j(c.get_status(CHAIN, Some(ETH.into()))),
        "chain": j(c.get_chain(CHAIN)),
        "token": j(c.get_token(CHAIN, ETH.into())),
        "recipients": j(c.list_recipients(CHAIN)),
        "agent": j(c.get_agent(acct(AGENT))),
        "tickets": j(c.list_tickets(None, None)),
        "nonce": j(c.get_nonce_state(CHAIN)),
        "scheduled": j(c.list_scheduled_changes()),
    })
}

#[test]
fn state_written_by_the_deployed_code_reads_the_same_under_the_new_code() {
    let c = old_deployment();
    let before = views_old(&c);
    assert_eq!(before["tickets"].as_array().map(Vec::len), Some(1), "the old code queued ticket 1");
    // What the runtime does when a call to the old code returns: write the state.
    env::state_write(&c);
    drop(c); // flushes the collections' cached entries to storage

    at(SELF, 0);
    let migrated = new::PolicySigner::migrate();
    let after = views_new(&migrated);
    assert_eq!(before, after, "every view must read the same after migrate");
    println!("views identical before and after migrate:\n{}", serde_json::to_string_pretty(&after).unwrap());
}

#[test]
fn the_new_code_works_on_migrated_state() {
    use new::policy::*;
    let c = old_deployment();
    env::state_write(&c);
    drop(c);
    at(SELF, 0);
    let mut c = new::PolicySigner::migrate();

    // The ticket queued by the old code is approved by the new code.
    at(OWNER, 1);
    c.approve_ticket(1);
    assert!(matches!(c.get_ticket(1).map(|t| t.status), Some(TicketStatus::Approved)));

    // Turn on the policy delay (applies at once from 0), then propose_owner is scheduled, not applied.
    let mut p = c.get_config().params;
    p.policy_delay_s = 3_600;
    at(OWNER, 1);
    c.set_params(p);
    assert_eq!(c.get_config().params.policy_delay_s, 3_600);
    at(OWNER, 1);
    c.propose_owner(acct("someone-else.testnet"));
    assert_eq!(c.get_config().proposed_owner, None, "proposing a new owner now waits for the delay");
    let scheduled = c.list_scheduled_changes();
    assert_eq!(scheduled.len(), 1);
    at(OWNER, 1);
    c.cancel_change(scheduled[0].id);
    assert!(c.list_scheduled_changes().is_empty());
    assert_eq!(c.get_config().owner, acct(OWNER));
}
