export type ApprovalForm = string[] & { readonly raw?: boolean };
export function approvalForms(words: string[]): ApprovalForm[];
export function npmWords(words: string[]): string[];
