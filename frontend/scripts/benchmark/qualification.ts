import {
  computeProfileHash,
  isQualifiedChain,
  validateCollectorProfile,
  type CollectorProfile,
  type DelayCheckResult,
  type TraceParseResult,
} from './collector'
import { SCENARIOS } from '../../src/components/editor/benchmarkHooks'

export interface QualificationInput {
  profile: CollectorProfile
  parsed: TraceParseResult
  appDelayCheck: DelayCheckResult
  labelDelayCheck: DelayCheckResult
  invalidRunReasons: string[]
  /**
   * What this profile is being sealed for. Defaults to the stricter
   * `acceptance`, so a caller cannot weaken the gate by omission.
   *
   * `collector` still requires a hardware adapter, observed host facts,
   * disabled fault injection and a usable clock mapping — it only drops the
   * reference window geometry, which belongs to an acceptance series.
   */
  mode?: 'collector' | 'acceptance'
}

/** Final publication boundary used by the driver before writing any verdict.
 * Expected verdict is deliberately not an input: it is an assertion, not evidence.
 */
export function finalizeQualification(input: QualificationInput) {
  const { parsed, appDelayCheck, labelDelayCheck } = input
  const profileValidation = validateCollectorProfile(input.profile, {
    requireAcceptanceMode: true,
    requireReferenceGeometry: (input.mode ?? 'acceptance') === 'acceptance',
  })
  const failures = [...profileValidation.errors, ...input.invalidRunReasons]
  if (!parsed.valid || parsed.verdict === 'NOT_MEASURED' || parsed.errors.length > 0) {
    failures.push('Parser evidence is invalid or not measured.', ...parsed.errors)
  }
  for (const scenario of SCENARIOS) {
    if (!parsed.chains.some((chain) => chain.scenario === scenario)) {
      failures.push(`No correlated browser input for ${scenario}; controlled replay is incomplete.`)
    }
  }
  const coherent = parsed.chains.length > 0 && parsed.chains.every(isQualifiedChain)
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
