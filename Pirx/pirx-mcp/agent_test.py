import asyncio
import json

from ollama import AsyncClient
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

MODEL = "qwen3:14b"


def to_ollama_tool(mcp_tools):
    """Convert MCP tool definitions to Ollama tool definitions."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.inputSchema,
            },
        }
        for tool in mcp_tools
    ]


def tool_result_to_text(result) -> str:
    """Convert MCP tool result to text for the LLM."""

    if result.structuredContent is not None:
        return json.dumps(
            result.structuredContent,
            ensure_ascii=False,
        )

    texts = []

    for content in result.content:
        if isinstance(content, types.TextContent):
            texts.append(content.text)

    return "\n".join(texts)


async def main():
    # Pirx MCP will be stared automatically by the client.
    server = StdioServerParameters(
        command="uv",
        args=["run", "server.py"],
    )

    ollama = AsyncClient(host="http://localhost:11434")

    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # Ask Pirx what tool it exposes.
            mcp_tools = (await session.list_tools()).tools
            tools = to_ollama_tool(mcp_tools)

            print("MCP tools:")
            for tool in mcp_tools:
                print(f" - {tool.name}")

            messages = []

            while True:
                user_input = input("\nTy: ").strip()

                if user_input in {"/exit", "/quit"}:
                    break

                messages.append(
                    {
                        "role": "user",
                        "content": user_input,
                    }
                )

                # Agent loop.
                while True:
                    response = await ollama.chat(
                        model=MODEL,
                        messages=messages,
                        tools=tools,
                    )
                    messages.append(response.message)

                    if not response.message.tool_calls:
                        print(f"\nPirx: {response.message.content}")
                        break

                    for call in response.message.tool_calls:
                        name = call.function.name
                        arguments = call.function.arguments or {}

                        print(f"\n[tool]  {name} {arguments}")

                        result = await session.call_tool(
                            name,
                            arguments=arguments,
                        )

                        tool_output = tool_result_to_text(result)

                        messages.append(
                            {
                                "role": "tool",
                                "tool_name": name,
                                "content": tool_output,
                            }
                        )


if __name__ == "__main__":
    asyncio.run(main())
