import { Bot, GitCompareArrows, ScanSearch } from "lucide-react";
import packageJson from "../../package.json";
import { usePreferencesStore } from "../stores/preferences.store";
import { useI18n } from "../utils/i18n";

export function OnboardingDialog() {
  const completeOnboarding = usePreferencesStore((state) => state.completeOnboarding);
  const onboardingSeen = usePreferencesStore((state) => state.onboardingSeen);
  const { t } = useI18n();
  if (onboardingSeen) return null;

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-dialog" aria-labelledby="onboarding-title" aria-modal="true" role="dialog">
        <p className="desktop-only-kicker">FlowWeave v{packageJson.version}</p>
        <h1 id="onboarding-title">{t("onboarding.title")}</h1>
        <p>{t("onboarding.body")}</p>
        <div className="onboarding-steps">
          <article>
            <ScanSearch size={18} />
            <strong>{t("onboarding.scanTitle")}</strong>
            <span>{t("onboarding.scanBody")}</span>
          </article>
          <article>
            <Bot size={18} />
            <strong>{t("onboarding.agentTitle")}</strong>
            <span>{t("onboarding.agentBody")}</span>
          </article>
          <article>
            <GitCompareArrows size={18} />
            <strong>{t("onboarding.reviewTitle")}</strong>
            <span>{t("onboarding.reviewBody")}</span>
          </article>
        </div>
        <button className="primary-button" type="button" onClick={completeOnboarding}>
          {t("onboarding.start")}
        </button>
      </section>
    </div>
  );
}
