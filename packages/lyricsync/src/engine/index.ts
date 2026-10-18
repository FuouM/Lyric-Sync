// src/engine/index.ts
export { solve, buildRawSets, boundaryEvidenceInputs } from './solve.ts';
export { solveAnalytic, ANALYTIC_DESIGN } from './analytic.ts';
export { loadWeights, readWeightsFile } from './weights.ts';
export { extractAndValidatePins, pinLineBoundaries, countLineSyllables } from './pins.ts';
export type { LinePins } from './pins.ts';
export { refineAlignment } from './consensus.ts';
export type { ConsensusLine, ConsensusNote, ConsensusWord, RefineAlignmentOptions } from './consensus.ts';
export {
  BoundaryEvidence,
  applyPath,
  buildProblems,
  decodeLineMbr,
  nodeMarginals,
  accumulateNllGradient,
  prepareProblem,
  weightsToVec,
  vecToWeights,
} from './boundary_dp.ts';
export type { BoundaryEvidenceInputs, LineProblem } from './boundary_dp.ts';
