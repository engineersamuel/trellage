use std::arch::x86_64::{
    __m256i, _mm256_castsi256_ps, _mm256_cmpgt_epi32, _mm256_loadu_si256, _mm256_movemask_ps,
    _mm256_set1_epi32,
};

pub(super) fn is_supported() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
}

pub(super) fn count_less(block: &[i32; 8], target: i32) -> usize {
    assert!(is_supported());
    unsafe { count_less_avx2(block, target) }
}

#[target_feature(enable = "avx2")]
unsafe fn count_less_avx2(block: &[i32; 8], target: i32) -> usize {
    let values = unsafe { _mm256_loadu_si256(block.as_ptr().cast::<__m256i>()) };
    let targets = _mm256_set1_epi32(target);
    let mask = _mm256_cmpgt_epi32(targets, values);
    _mm256_movemask_ps(_mm256_castsi256_ps(mask)).count_ones() as usize
}
