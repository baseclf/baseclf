import type { Metadata } from "next";
import SqlEditorApp from "./SqlEditorApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "SQL Editor — BaseCLF", description: "A clear SQL workbench for the BaseCLF Studio preview." };
export default function SqlEditorPage() { return <SqlEditorApp />; }
