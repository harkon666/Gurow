import {
  computeProfileHash,
  validateCollectorProfile,
  type CollectorProfile,
  type DelayCheckResult,
  type TraceParseResult,
} from './collector'

export interface QualificationInput {
  profile: CollectorProfile
  parsed: TraceParseResult
  appDelayCheck: DelayCheckResult
  labelDelayCheck: DelayCheckResult
  invalidRunReasons: string[]
}

/** Final publication boundary used by the driver before writing any verdict.
 * Expected verdict is deliberately not an input: it is an assertion, not evidence.
 */
export function finalizeQualification(input: QualificationInput) {
  const { parsed, appDelayCheck, labelDelayCheck } = input
  const profileValidation = validateCollectorProfile(input.profile, { requireAcceptanceMode: true })
  const failures = [...profileValidation.errors, ...input.invalidRunReasons]
  if (!parsed.valid || parsed.verdict === 'NOT_MEASURED' || parsed.errors.length > 0) {
    failures.push('Parser evidence is invalid or not measured.', ...parsed.errors)
  }
  for (const scenario of ['pan', 'zoom', 'drag']) {
    if (!parsed.chains.some((chain) => chain.scenario === scenario)) {
      failures.push(`No correlated browser input for ${scenario}; controlled replay is incomplete.`)
    }
  }
  const coherent = parsed.chains.length > 0 && parsed.chains.every((chain) =>
    chain.presentation_provenance === 'platform_presentation_feedback' &&
    chain.frame_link === 'revision_matched' &&
    typeof chain.presented_frame_id === 'string' && chain.presented_frame_id.trim().length > 0 &&
    chain.presentation_timestamp_ms !== null && Number.isFinite(chain.presentation_timestamp_ms) &&
    chain.latency_ms !== null && Number.isFinite(chain.latency_ms) && chain.latency_ms >= 0
  )
  for (const [name, check] of [['Application', appDelayCheck], ['Label', labelDelayCheck]] as const) {
    if (check.status === 'FAIL' || (coherent && (check.status !== 'PASS' || !check.pass))) {
      failures.push(`${name} delay gate ${check.status}: ${check.details}`)
    }
  }
  const reasons = [...parsed.errors, ...parsed.reasons, ...failures]
  let status: CollectorProfile['status'] = 'NOT_MEASURED'
  if (failures.length === 0) {
    status = parsed.verdict === 'QUALIFIED' && coherent ? 'QUALIFIED' : 'UNSUPPORTED'
    if (status === 'UNSUPPORTED') {
      reasons.push('Coherent canvas and label presentation is not demonstrated for every pan/zoom/drag input; optical acquisition is required.')
    }
  }
  const { hash: _hash, unsupported_reason: _reason, ...base } = input.profile
  const uniqueReasons = [...new Set(reasons)]
  const sealed: Omit<CollectorProfile, 'hash'> = {
    ...base, status,
    ...(status === 'QUALIFIED' ? {} : { unsupported_reason: uniqueReasons.join(' ') }),
  }
  return {
    profile: { ...sealed, hash: computeProfileHash(sealed) },
    profileValidation,
    reasons: uniqueReasons,
    failures: [...new Set(failures)],
    appDelayCheck,
    labelDelayCheck,
  }
}
