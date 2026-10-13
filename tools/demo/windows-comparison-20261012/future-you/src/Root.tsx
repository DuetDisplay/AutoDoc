import { MyComposition } from "./Composition";
import { MyShortComposition } from "./Short";
import { SeriesCompositions } from "../../series/Films";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MyComposition />
      <MyShortComposition />
      <SeriesCompositions />
    </>
  );
};
