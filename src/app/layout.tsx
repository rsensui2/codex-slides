import type { Metadata } from "next";
import CodexSetupProvider from "@/components/CodexSetupProvider";
import GlobalSettings from "@/components/GlobalSettings";
import { I18nProvider } from "@/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "Codex Slides 日本語版 — Codex内で使えるオープンソースAIスライドスタジオ",
  description:
    "ローカルのCodexエージェントで、日本語のスライドを調査・構成・生成・編集・書き出しできます。追加のAPIキーは不要です。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body>
        <I18nProvider>
          <CodexSetupProvider>
            <GlobalSettings />
            {children}
          </CodexSetupProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
