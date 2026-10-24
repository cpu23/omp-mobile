import { buildChart, planChart, worthCharting } from "@oh-my-pi/pi-tui/charts/chart-plan";
import { renderChartSvg } from "@oh-my-pi/pi-tui/charts/chart-svg";
import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";

export function renderTableChartSvg(headers: string[], rows: string[][]): string | null {
  const analysis = analyzeTable(headers, rows);
  const plan = planChart(analysis);
  if (!plan) return null;
  const chart = buildChart(analysis, plan);
  if (!chart || !worthCharting(chart)) return null;
  return renderChartSvg(chart);
}
