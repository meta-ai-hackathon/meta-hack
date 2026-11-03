// The literal Lovable stage-grid geometry (VAL-FIX-006), shared by every
// non-entry/non-results stage (the talk stage and the quick-questions
// stage): the frame's inner flow breaks out of the frame's side inset
// with matched negative margins, then carries the prototype's
// `padding: 35px 32px 20px` and the `30px` gap on wide viewports —
// one column until 1101px (the Coming Together rail collapses into the
// flow), two tracks (`minmax(0,1fr) 195px`) at 1101px+, and the 760px
// rule's block layout with 28px/20px paddings below. The app shell's
// 84px header region and the edge-to-edge frame live above this grid.
export const STAGE_GRID_CLASS =
  "-mx-5 px-5 pt-7 pb-7 min-[761px]:-mx-8 min-[761px]:grid min-[761px]:grid-cols-[minmax(0,1fr)] min-[761px]:gap-[30px] min-[761px]:px-8 min-[761px]:pt-[35px] min-[761px]:pb-5 min-[1101px]:grid-cols-[minmax(0,1fr)_195px]";
