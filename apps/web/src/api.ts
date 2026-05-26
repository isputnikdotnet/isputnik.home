export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  theme: "system" | "light" | "dark";
  protectedFromDelete: boolean;
  isActive: boolean;
  createdAt: string;
  deletedAt: string | null;
}

interface ApiErrorPayload {
  error?: string;
  details?: {
    fieldErrors?: Record<string, string[]>;
    formErrors?: string[];
  };
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    const fieldMessage = payload.details?.fieldErrors
      ? Object.entries(payload.details.fieldErrors)
          .flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`))
          .join("; ")
      : "";
    const formMessage = payload.details?.formErrors?.join("; ") ?? "";
    throw new Error(fieldMessage || formMessage || payload.error || "Request failed");
  }

  return response.json() as Promise<T>;
}
