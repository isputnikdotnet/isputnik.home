import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Shell } from "../app/Shell";
import { Field } from "./Field";
import { MessageBox } from "./MessageBox";

export function AccountForm({
  eyebrow,
  title,
  submitLabel,
  helper,
  onSubmit
}: {
  eyebrow: string;
  title: string;
  submitLabel: string;
  helper: string;
  onSubmit: (payload: { displayName: string; email: string; password: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(t("accountForm.mismatch"));
      return;
    }

    try {
      await onSubmit({ displayName, email, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accountForm.createFailed"));
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <MessageBox tone="info" title={t("accountForm.setupTitle")}>{helper}</MessageBox>
        <MessageBox tone="warning" title={t("accountForm.policyTitle")}>
          <Trans i18nKey="accountForm.policy" components={{ code: <code /> }} />
        </MessageBox>
        <Field label={t("accountForm.displayName")} value={displayName} onChange={setDisplayName} autoComplete="name" />
        <Field label={t("common.email")} type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label={t("common.password")}
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="new-password"
        />
        <Field
          label={t("accountForm.confirmPassword")}
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          minLength={8}
          autoComplete="new-password"
        />
        {error && <MessageBox tone="error" title={t("accountForm.attention")}>{error}</MessageBox>}
        <button className="primary-button">{submitLabel}</button>
      </form>
    </Shell>
  );
}
