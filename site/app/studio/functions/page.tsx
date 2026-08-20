import type { Metadata } from "next";
import FunctionsApp from "./FunctionsApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Functions & Cron — BaseCLF", description: "Design and schedule mock Worker functions in BaseCLF." };
export default function FunctionsPage() { return <FunctionsApp />; }
