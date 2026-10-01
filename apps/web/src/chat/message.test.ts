import type {
  AnswerQuestionOutput,
  AskDetailsOutput,
  AskFactOutput,
  CosWorkspace,
  CreateReminderOutput,
  CreateReminderRequest,
  RequestChangeOutput,
} from "@workspace/contracts"
import { expectTypeOf, it } from "vitest"
import type { ChatMessage } from "./message"

type Done<Name extends string> = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${Name}`; state: "output-available" }
>

it("types each tool part's input and output from its contract", () => {
  expectTypeOf<Done<"get_workspace">["output"]>().toEqualTypeOf<CosWorkspace>()
  expectTypeOf<
    Done<"request_change">["output"]
  >().toEqualTypeOf<RequestChangeOutput>()
  expectTypeOf<
    Done<"answer_question">["output"]
  >().toEqualTypeOf<AnswerQuestionOutput>()
  expectTypeOf<
    Done<"create_reminder">["input"]
  >().toEqualTypeOf<CreateReminderRequest>()
  expectTypeOf<
    Done<"create_reminder">["output"]
  >().toEqualTypeOf<CreateReminderOutput>()
  expectTypeOf<Done<"ask_fact">["output"]>().toEqualTypeOf<AskFactOutput>()
  expectTypeOf<
    Done<"ask_details">["output"]
  >().toEqualTypeOf<AskDetailsOutput>()
  // A tool the contracts do not name has no part.
  expectTypeOf<Done<"publish">>().toBeNever()
})
