//! Floor arithmetic with a 256-bit intermediate.
//!
//! Share amounts are 18-decimal fixed point, so `ui_shares * 1e18` overflows a
//! u128 at about 340 shares. Solidity's `Math.mulDiv` avoids that with a
//! 512-bit product; this does the same with a 256-bit product, which is enough
//! because every operand here fits in a u128.

pub const WAD: u128 = 1_000_000_000_000_000_000;

/// `floor(a * b / d)`, or `None` when `d == 0` or the result does not fit in a u128.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (hi, lo) = full_mul(a, b);
    // The quotient fits in 128 bits exactly when the high half is below the divisor.
    if hi >= d {
        return None;
    }
    Some(div_256_by_128(hi, lo, d))
}

/// 128 x 128 -> 256 bit product as (high, low).
fn full_mul(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & MASK);
    let (b1, b0) = (b >> 64, b & MASK);

    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;

    let mid = (p00 >> 64) + (p01 & MASK) + (p10 & MASK);
    let lo = (p00 & MASK) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// Divide the 256-bit value (hi, lo) by d, given hi < d. Bitwise long division.
fn div_256_by_128(hi: u128, lo: u128, d: u128) -> u128 {
    let mut rem = hi;
    let mut quot: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        quot <<= 1;
        // `carry` means the shifted remainder exceeded 128 bits, so it is
        // certainly >= d; the wrapping subtraction then yields the true value.
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            quot |= 1;
        }
    }
    quot
}

/// Raw units for `ui_shares` at `multiplier`, floored. Matches
/// `ExactTransfer.transferShares` and `sharesToRaw` in `@shareexact/sdk`.
pub fn shares_to_raw(ui_shares: u128, multiplier: u128) -> Option<u128> {
    mul_div_floor(ui_shares, WAD, multiplier)
}

/// Shares actually represented by `raw` at `multiplier`, floored.
pub fn raw_to_shares(raw: u128, multiplier: u128) -> Option<u128> {
    mul_div_floor(raw, multiplier, WAD)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_live_mu_conversion() {
        // 1 share of MU at multiplier 1000183456682946507 is 999816576967234660 raw.
        assert_eq!(
            shares_to_raw(WAD, 1_000_183_456_682_946_507),
            Some(999_816_576_967_234_660)
        );
    }

    #[test]
    fn handles_products_wider_than_u128() {
        // 1,000,000 shares: ui_shares * WAD is 1e42, well past u128::MAX (~3.4e38).
        let ui = 1_000_000 * WAD;
        assert_eq!(shares_to_raw(ui, 4 * WAD), Some(250_000 * WAD));
        assert_eq!(shares_to_raw(ui, WAD), Some(ui));
    }

    #[test]
    fn floors() {
        assert_eq!(mul_div_floor(10, 1, 3), Some(3));
        assert_eq!(
            mul_div_floor(u128::MAX, u128::MAX, u128::MAX),
            Some(u128::MAX)
        );
        // u128::MAX = 2^128 - 1 is divisible by 3, so the exact answer is (MAX / 3) * 2.
        assert_eq!(mul_div_floor(u128::MAX, 2, 3), Some(u128::MAX / 3 * 2));
        assert_eq!(mul_div_floor(u128::MAX, 2, 5), Some(u128::MAX / 5 * 2));
    }

    #[test]
    fn rejects_zero_divisor_and_overflow() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), None);
    }

    #[test]
    fn agrees_with_native_math_when_it_fits() {
        let cases: [(u128, u128, u128); 5] = [
            (123_456_789, 987_654_321, 1_000_003),
            (WAD, WAD, 3),
            (7, 0, 5),
            (u64::MAX as u128, u64::MAX as u128, 17),
            (999_999_999_999, 1_000_000_007, 999_999_937),
        ];
        for (a, b, d) in cases {
            assert_eq!(mul_div_floor(a, b, d), Some(a * b / d), "{a} * {b} / {d}");
        }
    }
}
