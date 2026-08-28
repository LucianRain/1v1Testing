// Toggles for game mechanics that are still being tuned - flip these instead
// of ripping the underlying code out, so a mechanic can come back without
// re-implementing it.

// When true, playing a card for a car type you already have a living (or
// junked) one of merges into that existing car - upgrading it, or reviving
// it as a level-1 upgrade if it was junked - instead of coupling a second,
// separate car (see game.js's resolveSetup and main.js's renderHand).
// When false, this is the original behavior: any number of the same car
// type can coexist on one train, each played fresh with its own slot.
export const MERGE_ON_DUPLICATE = false;
