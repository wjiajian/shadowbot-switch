import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

// Pi 1.5.2's initial default. A public-SDK integration test detects drift.
// Supported levels are still read from each resolved model at runtime.
export const initialThinkingLevel: ModelThinkingLevel = 'medium';
