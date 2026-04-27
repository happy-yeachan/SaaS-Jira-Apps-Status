import type { RegisteredApp } from "@/types";

export const DEFAULT_APPS: RegisteredApp[] = [
  {
    id: "draw-io-diagrams",
    appName: "draw.io Diagrams",
    vendorName: "Seibert Media",
    checkType: "statuspage_api",
    statusUrl: "https://status.draw.io/index.json",
    logoUrl:
      "https://marketplace.atlassian.com/files/0f8db4f4-a2ea-4ac9-a9e2-d559f791b8d4",
  },
  {
    id: "custom-charts-for-jira",
    appName: "Custom Charts for Jira",
    vendorName: "Tempo",
    checkType: "statuspage_api",
    statusUrl: "https://status.tempo.io/api/v2/summary.json",
    logoUrl:
      "https://marketplace.atlassian.com/files/4ca41641-d2d9-4f20-bc1b-366a77e64e5b",
  },
  {
    id: "advanced-tables-for-confluence",
    appName: "Advanced Tables for Confluence",
    vendorName: "Appfire",
    checkType: "statuspage_api",
    statusUrl: "https://appfire-apps.statuspage.io/api/v2/summary.json",
    logoUrl:
      "https://marketplace.atlassian.com/files/985cbfd4-a083-4067-a20b-1fe2ce1eac7f",
  },
  {
    id: "zephyr",
    appName: "Zephyr",
    vendorName: "SmartBear",
    checkType: "statuspage_api",
    statusUrl: "https://zephyr.status.smartbear.com/api/v2/summary.json",
    logoUrl:
      "https://marketplace.atlassian.com/files/bec1a6ce-d327-4f1c-914c-0f66fa4f7e15",
  },
];
