/** Small, platform-independent rules for the arcade session. */
export const EXERCISES = Object.freeze([
  Object.freeze({ id: 'bicep-curl', label: 'BICEP CURL' }),
  Object.freeze({ id: 'overhead-press', label: 'OVERHEAD SHOULDER PRESS' }),
  Object.freeze({ id: 'lateral-raise', label: 'LATERAL RAISE' }),
]);

/** Use the timer's elapsed time, never rendered frames or rounded percentages. */
export function workoutExercise(snapshot) {
  if (snapshot.phase !== 'workout' || snapshot.status === 'completed' || !(snapshot.phaseDurationMs > 0)) return null;
  const elapsed = Math.max(0, Math.min(snapshot.phaseDurationMs, snapshot.phaseDurationMs - snapshot.remainingMs));
  const fraction = elapsed / snapshot.phaseDurationMs;
  const index = Math.min(2, Math.floor(fraction * 3));
  return { ...EXERCISES[index], index, facing: index === 1 ? -1 : 1,
    progress: Math.min(1, Math.max(0, fraction * 3 - index)) };
}
