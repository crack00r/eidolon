/**
 * Model router -- selects the best LLM provider for a given task type.
 *
 * Default routing:
 *   conversation, code-generation  -> claude only
 *   extraction, filtering, dreaming, summarization -> local first, claude fallback
 *   embedding -> local always
 */

import type {
  ILLMProvider,
  IModelRouter,
  LLMConfig,
  LLMProviderType,
  TaskRequirement,
  TaskRequirementType,
} from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

const DEFAULT_ROUTING: Record<TaskRequirementType, readonly LLMProviderType[]> = {
  conversation: ["claude"],
  "code-generation": ["claude"],
  extraction: ["ollama", "llamacpp", "claude"],
  filtering: ["ollama", "llamacpp", "claude"],
  dreaming: ["ollama", "llamacpp", "claude"],
  summarization: ["ollama", "llamacpp", "claude"],
  embedding: ["ollama", "llamacpp"],
};

export class ModelRouter implements IModelRouter {
  private readonly providers = new Map<LLMProviderType, ILLMProvider>();
  private readonly routing: Record<string, readonly LLMProviderType[]>;

  constructor(
    readonly config: LLMConfig,
    private readonly logger: Logger,
  ) {
    // Merge user routing overrides with defaults
    this.routing = { ...DEFAULT_ROUTING, ...config.routing };
  }

  registerProvider(provider: ILLMProvider): void {
    this.providers.set(provider.type, provider);
    this.logger.info("llm:router", `Registered provider: ${provider.type} (${provider.name})`);
  }

  getProvider(type: LLMProviderType): ILLMProvider | undefined {
    return this.providers.get(type);
  }

  getAllProviders(): readonly ILLMProvider[] {
    return [...this.providers.values()];
  }

  route(task: TaskRequirement): readonly LLMProviderType[] {
    const chain = this.routing[task.type] ?? DEFAULT_ROUTING[task.type] ?? ["claude"];
    // Filter to only registered providers
    return chain.filter((t) => this.providers.has(t));
  }

  /**
   * Select the first available provider for a task.
   */
  async selectProvider(task: TaskRequirement): Promise<ILLMProvider | undefined> {
    const chain = this.route(task);
    for (const type of chain) {
      const provider = this.providers.get(type);
      if (provider) {
        try {
          if (await provider.isAvailable()) {
            return provider;
          }
        } catch {
          this.logger.debug("llm:router", `Provider ${type} availability check failed`);
        }
      }
    }
    return undefined;
  }
}
