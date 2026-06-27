import { Save, Send } from "lucide-react";
import { Button } from "./Button";

export function AgentGuidanceComposer({
  disabled,
  isSaving,
  isSending,
  onChange,
  onSave,
  onSend,
  placeholder,
  saveLabel,
  sendDisabled,
  sendLabel,
  status,
  title,
  value
}: {
  disabled: boolean;
  isSaving: boolean;
  isSending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onSend: () => void;
  placeholder: string;
  saveLabel: string;
  sendDisabled?: boolean;
  sendLabel: string;
  status?: string;
  title: string;
  value: string;
}) {
  const actionDisabled = disabled || !value.trim();

  return (
    <section className="module-card agent-guidance-card">
      <h3>{title}</h3>
      <textarea
        aria-label={title}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="agent-guidance-actions">
        <Button
          disabled={actionDisabled || sendDisabled || isSaving || isSending}
          icon={<Save size={15} />}
          type="button"
          variant="subtle"
          onClick={onSave}
        >
          {saveLabel}
        </Button>
        <Button
          disabled={actionDisabled || isSaving || isSending}
          icon={<Send size={15} />}
          type="button"
          variant="primary"
          onClick={onSend}
        >
          {sendLabel}
        </Button>
      </div>
      {status ? <p className="agent-guidance-status">{status}</p> : null}
    </section>
  );
}
