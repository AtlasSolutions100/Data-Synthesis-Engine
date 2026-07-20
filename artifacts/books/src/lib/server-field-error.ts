import { ApiError } from "@workspace/api-client-react";

export interface ServerFieldError {
  field?: string | null;
  message: string;
}

export function toServerFieldError(
  error: unknown,
  fallbackMessage: string,
): ServerFieldError {
  if (error instanceof ApiError) {
    const data = error.data as { error?: string; field?: string } | null;
    return {
      message: data?.error ?? fallbackMessage,
      field: data?.field ?? null,
    };
  }
  return { message: fallbackMessage };
}
