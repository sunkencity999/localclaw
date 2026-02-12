import type { z } from "zod";
import type { IntegrationsSchema } from "../config/zod-schema.integrations.js";

export type IntegrationsConfig = z.infer<typeof IntegrationsSchema>;
