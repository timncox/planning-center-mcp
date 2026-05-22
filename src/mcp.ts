import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PlanningCenterClient } from './client.js';
import { PCO_CONTEXT_CONTENT, PCO_CONTEXT_PROMPT, PCO_ONBOARDING_CONTENT, PCO_ONBOARDING_PROMPT } from './prompts/pco-context.js';
import { getAnalyticsToolDefinitions, handleAnalyticsTool } from './tools/analytics.js';
import { getCalendarToolDefinitions, handleCalendarTool } from './tools/calendar.js';
import { getCapabilitiesToolDefinitions, handleCapabilitiesTool } from './tools/capabilities.js';
import { getCheckInsToolDefinitions, handleCheckInsTool } from './tools/checkins.js';
import { getGivingToolDefinitions, handleGivingTool } from './tools/giving.js';
import { getGroupsToolDefinitions, handleGroupsTool } from './tools/groups.js';
import { getPeopleToolDefinitions, handlePeopleTool } from './tools/people.js';
import { getRegistrationsToolDefinitions, handleRegistrationsTool } from './tools/registrations.js';
import { getServicesToolDefinitions, handleServicesTool } from './tools/services.js';
import { getWorkflowToolDefinitions, handleWorkflowTool, type WorkflowContext } from './tools/workflows.js';

export function createPlanningCenterMcpServer(client: PlanningCenterClient, workflowContext: WorkflowContext = {}) {
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? 'https://pco-mcp.cokistudio.com').replace(/\/$/, '');
  const server = new Server(
    {
      name: 'planning-center-mcp',
      title: 'Planning Center MCP',
      version: '1.0.0',
      websiteUrl: publicBaseUrl,
      description: 'Connect Claude to Planning Center Online for church operations workflows.',
      icons: [
        {
          src: `${publicBaseUrl}/logo.png`,
          mimeType: 'image/png',
          sizes: ['1200x1200'],
        },
      ],
    },
    { capabilities: { tools: {}, prompts: {} } }
  );

  const allTools = [
    ...getServicesToolDefinitions(),
    ...getPeopleToolDefinitions(),
    ...getGroupsToolDefinitions(),
    ...getRegistrationsToolDefinitions(),
    ...getCheckInsToolDefinitions(),
    ...getGivingToolDefinitions(),
    ...getAnalyticsToolDefinitions(),
    ...getWorkflowToolDefinitions(),
    ...getCapabilitiesToolDefinitions(),
    ...getCalendarToolDefinitions(),
  ];

  const servicesTools = new Set(getServicesToolDefinitions().map((tool) => tool.name));
  const peopleTools = new Set(getPeopleToolDefinitions().map((tool) => tool.name));
  const groupsTools = new Set(getGroupsToolDefinitions().map((tool) => tool.name));
  const registrationsTools = new Set(getRegistrationsToolDefinitions().map((tool) => tool.name));
  const checkInsTools = new Set(getCheckInsToolDefinitions().map((tool) => tool.name));
  const givingTools = new Set(getGivingToolDefinitions().map((tool) => tool.name));
  const analyticsTools = new Set(getAnalyticsToolDefinitions().map((tool) => tool.name));
  const workflowTools = new Set(getWorkflowToolDefinitions().map((tool) => tool.name));
  const capabilitiesTools = new Set(getCapabilitiesToolDefinitions().map((tool) => tool.name));
  const calendarTools = new Set(getCalendarToolDefinitions().map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let result: string;

    if (servicesTools.has(name)) {
      result = await handleServicesTool(name, args as Record<string, unknown>, client);
    } else if (peopleTools.has(name)) {
      result = await handlePeopleTool(name, args as Record<string, unknown>, client);
    } else if (groupsTools.has(name)) {
      result = await handleGroupsTool(name, args as Record<string, unknown>, client);
    } else if (registrationsTools.has(name)) {
      result = await handleRegistrationsTool(name, args as Record<string, unknown>, client);
    } else if (checkInsTools.has(name)) {
      result = await handleCheckInsTool(name, args as Record<string, unknown>, client);
    } else if (givingTools.has(name)) {
      result = await handleGivingTool(name, args as Record<string, unknown>, client);
    } else if (analyticsTools.has(name)) {
      result = await handleAnalyticsTool(name, args as Record<string, unknown>, client);
    } else if (workflowTools.has(name)) {
      result = await handleWorkflowTool(name, args as Record<string, unknown>, client, workflowContext);
    } else if (capabilitiesTools.has(name)) {
      result = await handleCapabilitiesTool(name);
    } else if (calendarTools.has(name)) {
      result = await handleCalendarTool(name, args as Record<string, unknown>, client);
    } else {
      result = JSON.stringify({
        success: false,
        data: null,
        error: `Unknown tool: ${name}`,
        metadata: {},
      });
    }

    return { content: [{ type: 'text' as const, text: result }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [PCO_CONTEXT_PROMPT, PCO_ONBOARDING_PROMPT],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === 'pco-context') {
      return {
        description: PCO_CONTEXT_PROMPT.description,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: PCO_CONTEXT_CONTENT },
          },
        ],
      };
    }
    if (request.params.name === 'pco-onboarding') {
      return {
        description: PCO_ONBOARDING_PROMPT.description,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: PCO_ONBOARDING_CONTENT },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  return server;
}
