const logoUrl = "/logo.svg";

export function BrandLogo({ className = "", label = "FlowWeave" }: { className?: string; label?: string }) {
  return <img alt={label} className={`brand-logo ${className}`.trim()} src={logoUrl} />;
}
