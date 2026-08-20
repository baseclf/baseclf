import type { Metadata } from "next";
import NewProjectApp from "./NewProjectApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Create project — BaseCLF", description: "Create a Cloudflare-native backend with BaseCLF." };

export default function NewProjectPage() { return <NewProjectApp />; }
