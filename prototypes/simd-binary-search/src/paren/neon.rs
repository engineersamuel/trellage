//! AArch64 NEON kernel for the parenthesis matcher.
//!
//! The scan keeps the scalar depth counter of `super::scalar` and only replaces
//! the byte inspection: each 16-byte block is compared against `(` and `)` in
//! one vector step, and blocks that carry no parenthesis at all are skipped
//! without touching the depth counter. Blocks that do carry a parenthesis are
//! resolved lane by lane in ascending byte order, so the first close
//! parenthesis that drives the depth to zero is the one reported.

use std::arch::aarch64::{vceqq_u8, vdupq_n_u8, vld1q_u8, vmaxvq_u8, vorrq_u8, vst1q_u8};

use super::ParenScan;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';

/// Vector block width in bytes: one full 128-bit NEON register of `u8` lanes.
const BLOCK: usize = 16;

pub(super) fn is_supported() -> bool {
    std::arch::is_aarch64_feature_detected!("neon")
}

/// Returns the index of the close parenthesis matching the open parenthesis at
/// `open_index`, along with the number of vector blocks the kernel consumed.
///
/// Returns `None` when `open_index` is out of bounds, when the byte at
/// `open_index` is not `(`, or when no matching close parenthesis exists.
pub(crate) fn scan(input: &[u8], open_index: usize) -> ParenScan {
    assert!(is_supported(), "the neon kernel requires neon support");

    // SAFETY: `is_supported` returned true immediately above, so the `neon`
    // target feature enabled on `scan_neon` is present on this machine.
    unsafe { scan_neon(input, open_index) }
}

#[target_feature(enable = "neon")]
unsafe fn scan_neon(input: &[u8], open_index: usize) -> ParenScan {
    if input.get(open_index) != Some(&OPEN) {
        return ParenScan {
            index: None,
            vector_steps: 0,
        };
    }

    // `open_index` indexes a byte of `input`, so it is smaller than
    // `input.len()` and the increment below cannot overflow.
    let mut position = open_index + 1;
    let mut depth: usize = 1;
    let mut vector_steps = 0;

    let opens = vdupq_n_u8(OPEN);
    let closes = vdupq_n_u8(CLOSE);

    // Whole blocks only: a block is entered exactly when 16 bytes remain, so
    // every load is full width and fully in bounds.
    while position + BLOCK <= input.len() {
        // SAFETY: the loop condition guarantees `position + 16 <= input.len()`,
        // so the 16 bytes read from `input.as_ptr().add(position)` all lie
        // inside the slice's allocation, and `vld1q_u8` needs no alignment
        // beyond that of `u8`.
        let block = unsafe { vld1q_u8(input.as_ptr().add(position)) };
        let open_mask = vceqq_u8(block, opens);
        let close_mask = vceqq_u8(block, closes);
        vector_steps += 1;

        // `vmaxvq_u8` is zero exactly when no lane matched either parenthesis,
        // which leaves the depth untouched and lets the block be skipped whole.
        if vmaxvq_u8(vorrq_u8(open_mask, close_mask)) != 0 {
            let mut open_lanes = [0_u8; BLOCK];
            let mut close_lanes = [0_u8; BLOCK];

            // SAFETY: `open_lanes` is a live, uniquely borrowed stack array of
            // exactly 16 `u8`, which is the width `vst1q_u8` writes.
            unsafe { vst1q_u8(open_lanes.as_mut_ptr(), open_mask) };
            // SAFETY: `close_lanes` is a live, uniquely borrowed stack array of
            // exactly 16 `u8`, which is the width `vst1q_u8` writes.
            unsafe { vst1q_u8(close_lanes.as_mut_ptr(), close_mask) };

            // Ascending lane order, so the earliest close parenthesis that
            // reaches depth zero is the one reported.
            for lane in 0..BLOCK {
                if open_lanes[lane] != 0 {
                    depth += 1;
                } else if close_lanes[lane] != 0 {
                    depth -= 1;
                    if depth == 0 {
                        return ParenScan {
                            index: Some(position + lane),
                            vector_steps,
                        };
                    }
                }
            }
        }

        position += BLOCK;
    }

    // Fewer than 16 bytes remain, so the tail is finished one byte at a time.
    while position < input.len() {
        match input[position] {
            OPEN => depth += 1,
            CLOSE => {
                depth -= 1;
                if depth == 0 {
                    return ParenScan {
                        index: Some(position),
                        vector_steps,
                    };
                }
            }
            _ => {}
        }
        position += 1;
    }

    ParenScan {
        index: None,
        vector_steps,
    }
}
