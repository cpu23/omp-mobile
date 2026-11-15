import mermaid from "mermaid";

const MERMAID_THEME_DEFAULT = {
  primaryColor: "#20242b",
  primaryTextColor: "#f0f2f5",
  primaryBorderColor: "#707783",
  lineColor: "#a7b0bd",
  secondaryColor: "#292f38",
  tertiaryColor: "#171a1f",
  background: "#171a1f",
  mainBkg: "#20242b",
  nodeBorder: "#707783",
  clusterBkg: "#20242b",
  clusterBorder: "#707783",
  titleColor: "#f0f2f5",
  edgeLabelBackground: "#171a1f",
  fontFamily: "system-ui, sans-serif",
};

/** Initialize and render only after Mermaid content is encountered. */
export async function renderMermaidSvg(
  id: string,
  source: string,
  theme: Record<string, string | undefined>,
): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: "linear" },
    sequence: { useMaxWidth: true },
    themeVariables: {
      ...MERMAID_THEME_DEFAULT,
      primaryColor: theme["--panel-soft"] ?? MERMAID_THEME_DEFAULT.primaryColor,
      primaryTextColor: theme["--text"] ?? MERMAID_THEME_DEFAULT.primaryTextColor,
      primaryBorderColor: theme["--line"] ?? MERMAID_THEME_DEFAULT.primaryBorderColor,
      lineColor: theme["--muted"] ?? MERMAID_THEME_DEFAULT.lineColor,
      secondaryColor: theme["--panel-soft"] ?? MERMAID_THEME_DEFAULT.secondaryColor,
      tertiaryColor: theme["--bg"] ?? MERMAID_THEME_DEFAULT.tertiaryColor,
      background: theme["--bg"] ?? MERMAID_THEME_DEFAULT.background,
      mainBkg: theme["--panel-soft"] ?? MERMAID_THEME_DEFAULT.mainBkg,
      nodeBorder: theme["--line"] ?? MERMAID_THEME_DEFAULT.nodeBorder,
      clusterBkg: theme["--bg"] ?? MERMAID_THEME_DEFAULT.clusterBkg,
      clusterBorder: theme["--line"] ?? MERMAID_THEME_DEFAULT.clusterBorder,
      titleColor: theme["--text"] ?? MERMAID_THEME_DEFAULT.titleColor,
      edgeLabelBackground: theme["--bg"] ?? MERMAID_THEME_DEFAULT.edgeLabelBackground,
    },
  });
  return (await mermaid.render(id, source)).svg;
}
