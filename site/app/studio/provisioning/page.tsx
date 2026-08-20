import type { Metadata } from "next";
import ProvisioningApp from "./ProvisioningApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Provisioning — BaseCLF", description: "Track each BaseCLF project setup step." };
export default function ProvisioningPage() { return <ProvisioningApp />; }
