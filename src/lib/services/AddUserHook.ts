import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";

/** The transaction Add user runs in (UserAccountService.addUser), including what the department hook writes. */
export type AccountTx = Pick<
  Prisma.TransactionClient,
  | "appUser"
  | "serviceLine"
  | "serviceLineAccessGrant"
  | "serviceLineAccessHistory"
  | "department"
  | "departmentAccessGrant"
  | "departmentAccessHistory"
  | "passwordCredential"
  | "passwordCredentialHistory"
  | "passwordSignInAttempt"
  | "signInBlock"
>;

/**
 * Hook for per-line extras saved in the same transaction as the new user's line access. Department access plugs in
 * here (DepartmentAccessService.addUserHook): it receives the transaction, the new email and the granted line ids.
 * Throw AddUserRejected to roll the whole save back with a message for the form.
 */
export type AddUserGrantHook = (tx: AccountTx, email: string, lineIds: string[], viewer: Viewer) => Promise<void>;

/** Thrown by an AddUserGrantHook: nothing is saved and the form shows `message`. */
export class AddUserRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddUserRejected";
  }
}
