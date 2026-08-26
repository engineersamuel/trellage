use std::arch::aarch64::{vcltq_s32, vdupq_n_s32, vld1q_s32, vst1q_u32};

pub(super) fn is_supported() -> bool {
    std::arch::is_aarch64_feature_detected!("neon")
}

pub(super) fn count_less(block: &[i32; 4], target: i32) -> usize {
    assert!(is_supported());
    unsafe { count_less_neon(block, target) }
}

#[target_feature(enable = "neon")]
unsafe fn count_less_neon(block: &[i32; 4], target: i32) -> usize {
    let values = unsafe { vld1q_s32(block.as_ptr()) };
    let targets = vdupq_n_s32(target);
    let mask = vcltq_s32(values, targets);
    let mut lanes = [0_u32; 4];
    unsafe { vst1q_u32(lanes.as_mut_ptr(), mask) };
    lanes.into_iter().filter(|lane| *lane != 0).count()
}
