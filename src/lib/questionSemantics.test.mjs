import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRequiredOnboardQuestions,
  resolutionQuestionCopy,
  semanticOptionLabel,
  specificationField,
} from "./questionSemantics.ts";

test("technical slide specifications lead translated option labels", () => {
  const aspect = { question: "页面比例选哪种？", field: "aspect" };
  const resolution = { question: "输出质量？", field: "resolution" };
  assert.equal(semanticOptionLabel(aspect, { value: "16:9", label: "宽屏演示" }), "16:9 · 宽屏演示");
  assert.equal(semanticOptionLabel(aspect, { value: "4:3", label: "传统 4:3" }), "4:3 · 传统");
  assert.equal(semanticOptionLabel(resolution, { value: "2k", label: "高清质量" }), "2K · 高清质量");
});

test("legacy questions recover aspect and resolution semantics from values", () => {
  assert.equal(specificationField({ options: [
    { value: "16:9", label: "Wide" },
    { value: "4:3", label: "Standard" },
  ] }), "aspect");
  assert.equal(specificationField({ options: [
    { value: "1K", label: "Standard" },
    { value: "2K", label: "High" },
    { value: "4K", label: "Ultra" },
  ] }), "resolution");
});

test("resolution fallback keeps canonical values in every locale", () => {
  for (const locale of ["zh-CN", "en", "ja"]) {
    const copy = resolutionQuestionCopy(locale);
    assert.ok(copy.question);
    assert.equal(copy.labels.length, 3);
  }
});

test("resolution fallback defaults to Japanese", () => {
  const questions = ensureRequiredOnboardQuestions([]);
  assert.equal(questions[0].question, "出力解像度はどれにしますか？");
  assert.deepEqual(questions[0].options?.map((option) => option.label), [
    "1K · 標準",
    "2K · 高画質",
    "4K · 超高画質",
  ]);
});

test("missing output quality is inserted after aspect with a 2K default", () => {
  const questions = ensureRequiredOnboardQuestions([
    { id: "pages", question: "Pages?", type: "number", recommended: "8", field: "pages" },
    {
      id: "aspect",
      question: "Aspect?",
      type: "single",
      field: "aspect",
      options: [
        { value: "16:9", label: "Widescreen" },
        { value: "4:3", label: "Standard" },
      ],
    },
    { id: "language", question: "Language?", type: "single", field: "language" },
  ], "en");
  assert.equal(questions[2].field, "resolution");
  assert.equal(questions[2].recommended, "2K");
  assert.deepEqual(questions[2].options?.map((option) => option.value), ["1K", "2K", "4K"]);
});
