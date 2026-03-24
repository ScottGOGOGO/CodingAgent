import type { ChatMessage } from "@vide/contracts";

interface Props {
  messages: ChatMessage[];
}

export function ConversationFeed({ messages }: Props) {
  const timeline = messages.slice(-12);

  return (
    <article className="panel feed">
      <div className="section-title">
        <h2>Conversation</h2>
      </div>
      <div className="message-list">
        {timeline.map((item) => (
          <div key={item.id} className={`message ${item.role}`}>
            <span>{item.role}</span>
            <p>{item.content}</p>
          </div>
        ))}
      </div>
    </article>
  );
}
