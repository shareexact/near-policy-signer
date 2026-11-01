//! EVM transaction construction. C1 builds every byte it signs; callers never
//! supply calldata or a hash.

use near_sdk::env;
use omni_transaction::evm::EVMTransaction;

pub type Address = [u8; 20];

/// `transfer(address,uint256)`
pub const SEL_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// `approve(address,uint256)`
pub const SEL_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// `transferShares(address,address,uint256,uint256)` on ShareExact `ExactTransfer`
pub const SEL_TRANSFER_SHARES: [u8; 4] = selector_transfer_shares();

const fn selector_transfer_shares() -> [u8; 4] {
    // keccak256("transferShares(address,address,uint256,uint256)")[0..4],
    // pinned by the `selectors_match_keccak` test below.
    [0xa1, 0x77, 0x4e, 0xa4]
}

/// Parse a `0x`-prefixed, 40-hex-digit address. Mixed case is accepted; the
/// EIP-55 checksum is not enforced because C2 and the owner both pass
/// lowercase, and a checksum mismatch is not a policy question.
pub fn parse_address(s: &str) -> Result<Address, String> {
    let hex = s
        .strip_prefix("0x")
        .ok_or_else(|| format!("address {s} must start with 0x"))?;
    if hex.len() != 40 {
        return Err(format!("address {s} must have 40 hex digits"));
    }
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
            .map_err(|_| format!("address {s} is not hex"))?;
    }
    Ok(out)
}

pub fn address_hex(a: &Address) -> String {
    format!("0x{}", to_hex(a))
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

fn word_address(a: &Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn abi_call(selector: [u8; 4], words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 32 * words.len());
    out.extend_from_slice(&selector);
    for w in words {
        out.extend_from_slice(w);
    }
    out
}

/// ERC-20 `transfer(recipient, raw)`. Mode D.
pub fn calldata_transfer(recipient: &Address, raw: u128) -> Vec<u8> {
    abi_call(SEL_TRANSFER, &[word_address(recipient), word_u128(raw)])
}

/// ERC-20 `approve(spender, raw)`. Owner-only, for Mode X.
pub fn calldata_approve(spender: &Address, raw: u128) -> Vec<u8> {
    abi_call(SEL_APPROVE, &[word_address(spender), word_u128(raw)])
}

/// `ExactTransfer.transferShares(token, recipient, uiShares, maxShortfall)`. Mode X.
pub fn calldata_transfer_shares(
    token: &Address,
    recipient: &Address,
    ui_shares: u128,
    max_shortfall: u128,
) -> Vec<u8> {
    abi_call(
        SEL_TRANSFER_SHARES,
        &[
            word_address(token),
            word_address(recipient),
            word_u128(ui_shares),
            word_u128(max_shortfall),
        ],
    )
}

/// The fields C1 signs, in one place, so the payload signed is provably the
/// payload checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxFields {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: Address,
    pub input: Vec<u8>,
    pub gas_limit: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
}

impl TxFields {
    /// EIP-1559 (type 2) signing payload: `0x02 || rlp([...])`. Value is always 0:
    /// C1 never moves native ETH.
    pub fn unsigned_bytes(&self) -> Vec<u8> {
        EVMTransaction {
            chain_id: self.chain_id,
            nonce: self.nonce,
            to: Some(self.to),
            value: 0,
            input: self.input.clone(),
            gas_limit: self.gas_limit,
            max_fee_per_gas: self.max_fee_per_gas,
            max_priority_fee_per_gas: self.max_priority_fee_per_gas,
            access_list: vec![],
        }
        .build_for_signing()
    }

    pub fn sighash(&self) -> [u8; 32] {
        let h = env::keccak256(self.unsigned_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(&h);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_match_keccak() {
        let sel = |sig: &str| -> [u8; 4] {
            let h = env::keccak256(sig.as_bytes());
            [h[0], h[1], h[2], h[3]]
        };
        assert_eq!(sel("transfer(address,uint256)"), SEL_TRANSFER);
        assert_eq!(sel("approve(address,uint256)"), SEL_APPROVE);
        assert_eq!(
            sel("transferShares(address,address,uint256,uint256)"),
            SEL_TRANSFER_SHARES
        );
    }

    #[test]
    fn parses_addresses_strictly() {
        let a = parse_address("0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E").unwrap();
        assert_eq!(
            address_hex(&a),
            "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e"
        );
        assert!(parse_address("C9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E").is_err());
        assert!(parse_address("0x1234").is_err());
        assert!(parse_address("0xZZf9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E").is_err());
    }

    #[test]
    fn transfer_calldata_layout() {
        let to = parse_address("0x000000000000000000000000000000000000dEaD").unwrap();
        let data = calldata_transfer(&to, 999_816_576_967_234_660);
        assert_eq!(
            to_hex(&data),
            "a9059cbb\
             000000000000000000000000000000000000000000000000000000000000dead\
             0000000000000000000000000000000000000000000000000de00fe126add464"
        );
    }
}
