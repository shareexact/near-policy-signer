//! The full path in a NEAR sandbox: an agent's `request`, the contract's call to
//! `sign` on the signer account (here `mock-signer`, which has the MPC contract's
//! argument and response shapes), and the `on_signed` callback. Unit tests cover
//! `evaluate`; this covers the cross-contract promise, the callback and the state
//! it leaves, including a failed sign call.
//!
//! Sandbox accounts end in `.test.near`, so the contract is initialised with
//! `network: Mainnet` (a `.testnet` signer is required for `Testnet`). Nothing
//! here touches a real chain; mock signatures do not recover to any address.

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const CHAIN: u64 = 46_630;
const ETH: &str = "0x0000000000000000000000000000000000000000";
const ALICE: &str = "0x0c7f5b0f2cba6a576f92f60205e87f4d28080490";
const ALICE_OLD: &str = "0x0c7f9e1d4a3b7c2f8e6d5a4b3c2d1e0f9a8b0490"; // same first and last 4 hex digits
const POLICY_WASM: &str = "../target/near/policy_signer/policy_signer.wasm";
const MOCK_WASM: &str = "../target/near/mock_signer/mock_signer.wasm";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

struct World {
    policy: Contract,
    mock: Contract,
    owner: Account,
    agent: Account,
}

fn events(logs: &[&str]) -> Vec<String> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter_map(|v| v["event"].as_str().map(str::to_string))
        .collect()
}

async fn owner_call(w: &World, method: &str, args: Value) -> anyhow::Result<()> {
    let r = w
        .owner
        .call(w.policy.id(), method)
        .args_json(args)
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "{method} failed: {:?}", r.into_result().err());
    Ok(())
}

/// Sends `request` as the agent. Returns the outcome JSON and the event names logged along the way.
async fn request(w: &World, recipient: &str, amount: &str, evm_nonce: u64, ticket: Option<u64>) -> anyhow::Result<(Value, Vec<String>)> {
    let args = json!({ "request": {
        "chain_id": CHAIN, "token": ETH, "recipient": recipient, "amount": amount,
        "max_shortfall": "0", "observed": null,
        "fees": { "evm_nonce": evm_nonce, "gas_limit": "120000", "max_fee_per_gas": "40000000", "max_priority_fee_per_gas": "1000000" },
        "ticket_id": ticket,
    }});
    let r = w
        .agent
        .call(w.policy.id(), "request")
        .args_json(args)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let ev = events(&r.logs());
    let out: Value = r.into_result().map_err(|e| anyhow::anyhow!("request failed: {e:?}"))?.json()?;
    Ok((out, ev))
}

async fn status(w: &World) -> anyhow::Result<Value> {
    Ok(w.policy
        .view("get_status")
        .args_json(json!({ "chain_id": CHAIN, "token": ETH }))
        .await?
        .json()?)
}
async fn mock_calls(w: &World) -> anyhow::Result<u64> {
    Ok(w.mock.view("get_calls").await?.json()?)
}

async fn setup() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mock = worker.dev_deploy(&std::fs::read(MOCK_WASM)?).await?;
    anyhow::ensure!(mock.call("new").transact().await?.is_success(), "mock new");

    let policy_acc = root
        .create_subaccount("policy")
        .initial_balance(NearToken::from_near(40))
        .transact()
        .await?
        .into_result()?;
    let policy = policy_acc.deploy(&std::fs::read(POLICY_WASM)?).await?.into_result()?;
    let owner = root
        .create_subaccount("owner")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let agent = root
        .create_subaccount("agent")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let init = policy
        .call("new")
        .args_json(json!({ "owner": owner.id(), "signer": mock.id(), "path": "robinhood-46630-1", "network": "Mainnet" }))
        .transact()
        .await?;
    anyhow::ensure!(init.is_success(), "policy new: {:?}", init.into_result().err());

    let w = World {
        policy,
        mock,
        owner,
        agent,
    };
    owner_call(
        &w,
        "add_agent",
        json!({ "agent": w.agent.id(), "policy": { "enabled": true, "label": "sandbox agent", "max_requests_per_day": 20 } }),
    )
    .await?;
    owner_call(
        &w,
        "set_chain",
        json!({ "chain_id": CHAIN, "policy": {
        "max_fee_per_gas": "1000000000", "max_priority_fee_per_gas": "100000000", "max_gas_limit": "200000",
        "exact_transfer": null, "unknown_recipients_need_approval": true } }),
    )
    .await?;
    owner_call(&w, "set_token", json!({ "chain_id": CHAIN, "token": ETH, "policy": {
        "kind": "Native", "max_per_request": "1000000000000000", "max_per_day": "5000000000000000", "approval_above": "500000000000000" } })).await?;
    owner_call(
        &w,
        "set_recipient",
        json!({ "chain_id": CHAIN, "recipient": ALICE, "allowed": true }),
    )
    .await?;
    Ok(w)
}

#[tokio::test]
async fn request_sign_and_callback_end_to_end() -> anyhow::Result<()> {
    let w = setup().await?;

    // Inside the limits: the contract builds the transaction, calls `sign`, and the callback records it.
    let (out, ev) = request(&w, ALICE, "400000000000000", 0, None).await?;
    assert_eq!(out["status"], "SIGNED", "{out}");
    assert_eq!(out["nonce"], 0);
    assert!(
        out["unsigned_tx"].as_str().is_some_and(|t| t.starts_with("0x02")),
        "an EIP-1559 transaction: {out}"
    );
    assert!(ev.contains(&"signed".to_string()), "events: {ev:?}");
    assert_eq!(mock_calls(&w).await?, 1, "one call to the signer");
    let s = status(&w).await?;
    assert_eq!(s["next_nonce"], 1);
    assert_eq!(s["spent_today"], "400000000000000");
    assert!(s["in_flight"].is_null(), "the callback cleared the in-flight request: {s}");

    // Over the cap: refused on chain, with a `refused` event; the signer is never called.
    let (out, ev) = request(&w, ALICE, "2000000000000000", 1, None).await?;
    assert_eq!(out["status"], "REFUSED");
    assert_eq!(out["reason"], "AmountCapExceeded");
    assert!(ev.contains(&"refused".to_string()), "events: {ev:?}");
    assert_eq!(mock_calls(&w).await?, 1);

    // A look-alike of an allowlisted recipient: refused, never queued.
    let (out, _) = request(&w, ALICE_OLD, "400000000000000", 1, None).await?;
    assert_eq!(out["status"], "REFUSED");
    assert_eq!(out["reason"], "LookalikeRecipient");
    assert_eq!(status(&w).await?["open_tickets"], 0);

    // Above the approval threshold: queued; signed only after the owner approves that ticket.
    let (out, _) = request(&w, ALICE, "800000000000000", 1, None).await?;
    assert_eq!(out["status"], "PENDING_APPROVAL", "{out}");
    let ticket = out["ticket_id"].as_u64().expect("ticket id");
    assert_eq!(mock_calls(&w).await?, 1, "nothing signed while waiting");
    owner_call(&w, "approve_ticket", json!({ "ticket_id": ticket })).await?;
    let (out, _) = request(&w, ALICE, "800000000000000", 1, Some(ticket)).await?;
    assert_eq!(out["status"], "SIGNED", "{out}");
    assert_eq!(out["nonce"], 1);
    assert_eq!(mock_calls(&w).await?, 2);
    assert_eq!(status(&w).await?["spent_today"], "1200000000000000");

    // A failed sign call: treated as possibly signed. The nonce is not reused and the budget is not released.
    anyhow::ensure!(
        w.mock
            .call("set_fail")
            .args_json(json!({ "fail": true }))
            .transact()
            .await?
            .is_success(),
        "set_fail"
    );
    let (out, ev) = request(&w, ALICE, "100000000000000", 2, None).await?;
    assert_eq!(out["status"], "SIGN_FAILED", "{out}");
    assert!(ev.contains(&"sign_failed".to_string()), "events: {ev:?}");
    let s = status(&w).await?;
    assert_eq!(s["next_nonce"], 3, "nonce 2 stays used: {s}");
    assert_eq!(s["spent_today"], "1300000000000000", "budget not released");
    assert!(s["in_flight"].is_null());
    anyhow::ensure!(
        w.mock
            .call("set_fail")
            .args_json(json!({ "fail": false }))
            .transact()
            .await?
            .is_success(),
        "set_fail"
    );

    // Paused: every request is refused, whatever it asks for.
    owner_call(&w, "set_paused", json!({ "paused": true })).await?;
    let (out, _) = request(&w, ALICE, "100000000000000", 3, None).await?;
    assert_eq!(out["status"], "REFUSED");
    assert_eq!(out["reason"], "Paused");
    assert_eq!(
        mock_calls(&w).await?,
        2,
        "the signer was called twice in all (the failed call does not count)"
    );
    Ok(())
}

#[tokio::test]
async fn only_registered_agents_and_only_the_owner() -> anyhow::Result<()> {
    let w = setup().await?;
    // The owner is not an agent: its request is refused, not signed.
    let r = w
        .owner
        .call(w.policy.id(), "request")
        .args_json(json!({ "request": {
        "chain_id": CHAIN, "token": ETH, "recipient": ALICE, "amount": "400000000000000", "max_shortfall": "0", "observed": null,
        "fees": { "evm_nonce": 0, "gas_limit": "120000", "max_fee_per_gas": "40000000", "max_priority_fee_per_gas": "1000000" },
        "ticket_id": null } }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let out: Value = r.into_result().map_err(|e| anyhow::anyhow!("{e:?}"))?.json()?;
    assert_eq!(out["status"], "REFUSED", "{out}");
    assert_eq!(mock_calls(&w).await?, 0);
    // The agent cannot change policy: owner methods fail for it.
    let r = w
        .agent
        .call(w.policy.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(r.is_failure(), "an agent must not pause");
    // And `on_signed` is private.
    let r = w
        .agent
        .call(w.policy.id(), "on_signed")
        .args_json(json!({ "chain_id": CHAIN, "request_id": 1 }))
        .transact()
        .await?;
    assert!(r.is_failure(), "on_signed must be private");
    Ok(())
}
