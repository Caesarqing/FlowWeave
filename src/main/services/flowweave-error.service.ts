import type { FlowWeaveErrorCategory, FlowWeaveErrorData } from "../../types";

export class FlowWeaveError extends Error {
  readonly code: string;
  readonly category: FlowWeaveErrorCategory;
  readonly context: FlowWeaveErrorData["context"];
  readonly suggestedActions: string[];
  readonly technicalDetails?: string;

  constructor(data: FlowWeaveErrorData) {
    super(data.message);
    this.name = "FlowWeaveError";
    this.code = data.code;
    this.category = data.category;
    this.context = data.context;
    this.suggestedActions = data.suggestedActions;
    this.technicalDetails = data.technicalDetails;
  }
}
