import type { Metadata } from "next";
import SettingsApp from "./SettingsApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Project Settings — BaseCLF", description: "Manage mock BaseCLF project settings, environments, and secrets." };
export default function SettingsPage() { return <SettingsApp />; }
