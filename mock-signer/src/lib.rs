//! Mock MPC signer (C7). Sandbox and unit tests only.
//!
//! near-workspaces sandboxes have no MPC network, so the policy signer's
//! full request, sign and callback path cannot run there against the real
//! `v1.signer`. This contract answers `sign` with the same argument and
//! response shape, so that path can be exercised without keys or funds.
//!
//! Its signatures are deterministic placeholders derived from the payload.
//! They do NOT recover to any address and must never be broadcast. Never
//! point a deployed policy signer at this contract outside a sandbox.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, PanicOnDefault};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Payload {
    #[serde(rename = "Ecdsa")]
    pub ecdsa: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub payload_v2: Payload,
    pub path: String,
    pub domain_id: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    /// When set, every `sign` call panics, to exercise the failure callback.
    fail: bool,
    calls: u64,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new() -> Self {
        Self { fail: false, calls: 0 }
    }

    /// Same argument shape as the MPC contract's `sign`.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Value {
        require!(env::attached_deposit().as_yoctonear() >= 1, "attach at least 1 yoctoNEAR");
        require!(request.domain_id == 0, "mock supports secp256k1 (domain 0) only");
        let hash = request.payload_v2.ecdsa.trim_start_matches("0x");
        require!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()), "payload must be 32 bytes hex");
        require!(!self.fail, "mock signer set to fail");
        self.calls += 1;

        let seed = format!("{}|{}|{}", env::predecessor_account_id(), request.path, hash);
        let r = hex(&env::keccak256(format!("r|{seed}").as_bytes()));
        let s = hex(&env::keccak256(format!("s|{seed}").as_bytes()));
        json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": format!("02{r}") },
            "s": { "scalar": s },
            "recovery_id": 0,
            "mock": true,
        })
    }

    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    pub fn get_calls(&self) -> u64 {
        self.calls
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    fn call(deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id("policy.test.near".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(b.build());
    }

    fn request() -> SignRequest {
        SignRequest {
            payload_v2: Payload { ecdsa: "d6bd87cccf2d404096fb7cdd9c10f99e4a330c4a5a7a9d94930e377196015c62".into() },
            path: "robinhood-46630-1".into(),
            domain_id: 0,
        }
    }

    #[test]
    fn answers_in_the_mpc_response_shape() {
        call(1);
        let mut m = MockSigner::new();
        let a = m.sign(request());
        let b = m.sign(request());
        assert_eq!(a, b, "deterministic");
        assert_eq!(a["scheme"], "Secp256k1");
        assert_eq!(a["recovery_id"], 0);
        assert_eq!(a["big_r"]["affine_point"].as_str().unwrap().len(), 66);
        assert_eq!(a["s"]["scalar"].as_str().unwrap().len(), 64);
        assert_eq!(a["mock"], true);
        assert_eq!(m.get_calls(), 2);
    }

    #[test]
    #[should_panic(expected = "attach at least 1 yoctoNEAR")]
    fn requires_the_deposit() {
        call(0);
        MockSigner::new().sign(request());
    }

    #[test]
    #[should_panic(expected = "mock signer set to fail")]
    fn can_be_set_to_fail() {
        call(1);
        let mut m = MockSigner::new();
        m.set_fail(true);
        m.sign(request());
    }

    #[test]
    #[should_panic(expected = "payload must be 32 bytes hex")]
    fn rejects_a_malformed_payload() {
        call(1);
        let mut r = request();
        r.payload_v2.ecdsa = "abcd".into();
        MockSigner::new().sign(r);
    }
}
