import { Bot, Send, User, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { processImageUrl } from '@/lib/utils';

interface Message {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: Date;
  recommendations?: MovieRecommendation[];
  youtubeVideos?: YouTubeVideo[];
  isMovieCard?: boolean;
  movieInfo?: {
    title: string;
    poster: string;
    doubanLink: string;
  };
  hiddenContent?: string;
}

interface MovieRecommendation {
  title: string;
  year?: string;
  genre?: string;
  description: string;
  poster?: string;
}

interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  channelTitle: string;
  publishedAt: string;
}

interface AIChatModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const AIChatModal = ({ isOpen, onClose }: AIChatModalProps) => {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'ai',
      content: '你好！我是AI推荐助手，可以根据你的喜好为你推荐精彩的影视作品和YouTube视频。\n\n如果你想看电影、电视剧、动漫等影视内容，我会为你推荐相关作品；\n如果你想看新闻、教程、解说、音乐等视频内容，我会为你推荐YouTube视频。\n\n请告诉我你想看什么类型的内容吧！',
      timestamp: new Date()
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // 确保组件在客户端挂载后才渲染 Portal
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      try {
        // 首先检查是否有预设内容（优先级最高）
        const presetContent = localStorage.getItem('ai-chat-preset');
        if (presetContent) {
          try {
            const preset = JSON.parse(presetContent);

            // 模拟发送海报卡片消息
            const movieCardMessage: Message = {
              id: 'movie-card-' + Date.now(),
              type: 'user',
              content: `[发送了《${preset.title}》的海报卡片]`,
              timestamp: new Date(),
              isMovieCard: true,
              movieInfo: {
                title: preset.title,
                poster: preset.poster,
                doubanLink: preset.doubanLink
              },
              hiddenContent: preset.hiddenContent
            };

            // AI预设回复
            const aiReplyMessage: Message = {
              id: 'ai-reply-' + Date.now(),
              type: 'ai',
              content: `你想了解《${preset.title}》的什么相关信息呢？`,
              timestamp: new Date()
            };

            setMessages([
              {
                id: '1',
                type: 'ai',
                content: '你好！我是AI推荐助手，可以根据你的喜好为你推荐精彩的影视作品和YouTube视频。\n\n如果你想看电影、电视剧、动漫等影视内容，我会为你推荐相关作品；\n如果你想看新闻、教程、解说、音乐等视频内容，我会为你推荐YouTube视频。\n\n请告诉我你想看什么类型的内容吧！',
                timestamp: new Date()
              },
              movieCardMessage,
              aiReplyMessage
            ]);

            // 清除预设内容
            localStorage.removeItem('ai-chat-preset');
            return; // 有预设内容时不加载缓存消息
          } catch (error) {
            console.error('Failed to parse preset content:', error);
          }
        }

        // 没有预设内容时才加载缓存消息
        const cachedMessages = localStorage.getItem('ai-chat-messages');
        if (cachedMessages) {
          const { messages: storedMessages, timestamp } = JSON.parse(cachedMessages);
          const now = new Date().getTime();
          if (now - timestamp < 30 * 60 * 1000) {
            setMessages(storedMessages.map((msg: Message) => ({ ...msg, timestamp: new Date(msg.timestamp) })));
            return;
          }
        }
      } catch (error) {
        console.error("Failed to load messages from cache", error);
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      try {
        const cache = { messages, timestamp: new Date().getTime() };
        localStorage.setItem('ai-chat-messages', JSON.stringify(cache));
      } catch (error) {
        console.error("Failed to save messages to cache", error);
      }
    }
  }, [messages, isOpen]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    // 检查最后一条消息是否是电影卡片消息，如果是则组合隐藏内容
    const lastMessage = messages[messages.length - 1];
    let actualContent = inputValue.trim();

    if (lastMessage && lastMessage.isMovieCard && lastMessage.hiddenContent) {
      // 组合隐藏内容和用户输入
      actualContent = `${lastMessage.hiddenContent}\n\n用户问题：${inputValue.trim()}`;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: inputValue.trim(), // 显示内容仍然是用户输入的内容
      timestamp: new Date()
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInputValue('');
    setIsLoading(true);

    // 构建对话历史，使用实际内容（包含隐藏内容）
    const conversationHistory = updatedMessages.slice(-8).map(msg => {
      if (msg === userMessage) {
        // 对于刚发送的消息，使用包含隐藏内容的实际内容
        return { role: msg.type, content: actualContent };
      }
      return { role: msg.type, content: msg.content };
    });

    try {
      const response = await fetch('/api/ai/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversationHistory })
      });

      if (!response.ok) throw new Error('推荐请求失败');

      const data = await response.json();
      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'ai',
        content: data.content || '抱歉，我现在无法为你推荐内容，请稍后再试。',
        timestamp: new Date(),
        recommendations: data.recommendations || [],
        youtubeVideos: data.youtubeVideos || []
      };

      setMessages(prev => [...prev, aiMessage]);
    } catch (error) {
      console.error('AI推荐失败:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'ai',
        content: '抱歉，网络连接出现问题，请检查网络后重试。如果问题持续存在，请稍后再试。',
        timestamp: new Date(),
        recommendations: [],
        youtubeVideos: []
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleMovieSelect = (movie: MovieRecommendation) => {
    const searchQuery = encodeURIComponent(movie.title);
    router.push(`/search?q=${searchQuery}`);
    onClose();
  };

  const handleYouTubeVideoSelect = (video: YouTubeVideo) => {
    setPlayingVideoId(video.id);
  };

  // 处理点击背景遮罩层关闭模态框
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!isOpen || !mounted) return null;

  const modalContent = (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999999] p-4"
      onClick={handleBackdropClick}
      style={{ zIndex: 9999999 }}
    >
      <div className="glass-strong rounded-lg shadow-xl w-full max-w-2xl h-[80vh] flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">NewTV AI 荐片助手</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message) => (
            <div key={message.id} className={`flex gap-3 ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}>
              {message.type === 'ai' && (
                <div className="w-8 h-8 rounded-full border border-gray-300 dark:border-gray-600 flex items-center justify-center flex-shrink-0 self-start">
                  <Bot className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </div>
              )}
              <div className={`flex flex-col max-w-[80%] ${message.type === 'user' ? 'items-end' : 'items-start'}`}>
                {message.isMovieCard && message.movieInfo && (
                  <div className="mb-3 p-3 glass-light rounded-lg border border-gray-200 dark:border-gray-600 self-stretch">
                    <div className="flex items-start gap-3">
                      <div className="w-16 h-20 bg-gray-200 dark:bg-gray-700 rounded flex-shrink-0 overflow-hidden">
                        <img
                          src={processImageUrl(message.movieInfo.poster)}
                          alt={message.movieInfo.title}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent && !parent.querySelector('.poster-placeholder')) {
                              const placeholder = document.createElement('div');
                              placeholder.className = 'poster-placeholder w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500 text-xs';
                              placeholder.textContent = '海报';
                              parent.appendChild(placeholder);
                            }
                          }}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-gray-900 dark:text-white text-sm mb-2">{message.movieInfo.title}</h4>
                        <a
                          href={message.movieInfo.doubanLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          查看详情
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>
                    </div>
                  </div>
                )}
                <div className={`p-3 rounded-2xl ${message.type === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700'}`}>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                </div>
                {message.recommendations && message.recommendations.length > 0 && (
                  <div className="mt-3 space-y-2 self-stretch">
                    {message.recommendations.map((movie, index) => (
                      <div key={index} onClick={() => handleMovieSelect(movie)} className="p-3 glass-light rounded-lg cursor-pointer hover:shadow-md transition-all">
                        <div className="flex items-start gap-3">
                          {movie.poster && <img src={processImageUrl(movie.poster)} alt={movie.title} className="w-12 h-16 object-cover rounded flex-shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-gray-900 dark:text-white text-sm">{movie.title}{movie.year && <span className="text-gray-500 dark:text-gray-400 ml-1">({movie.year})</span>}</h4>
                            {movie.genre && <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">{movie.genre}</p>}
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">{movie.description}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {message.youtubeVideos && message.youtubeVideos.length > 0 && (
                  <div className="mt-3 space-y-2 self-stretch">
                    {message.youtubeVideos.map((video, index) => (
                      <div key={index} className="glass-light rounded-lg overflow-hidden">
                        {playingVideoId === video.id ? (
                          <div className="relative">
                            <div className="aspect-video">
                              <iframe
                                src={`https://www.youtube.com/embed/${video.id}?autoplay=1&rel=0`}
                                className="w-full h-full"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                allowFullScreen
                                title={video.title}
                              />
                            </div>
                            <button
                              onClick={() => setPlayingVideoId(null)}
                              className="absolute top-2 right-2 bg-black bg-opacity-50 text-white rounded-full p-1 hover:bg-opacity-70 transition-opacity"
                            >
                              <X className="w-4 h-4" />
                            </button>
                            <div className="p-3">
                              <h4 className="font-medium text-gray-900 dark:text-white text-sm">{video.title}</h4>
                              <p className="text-xs text-red-600 dark:text-red-400 mt-1">{video.channelTitle}</p>
                            </div>
                          </div>
                        ) : (
                          <div onClick={() => handleYouTubeVideoSelect(video)} className="p-3 cursor-pointer hover:shadow-md hover:border-red-300 dark:hover:border-red-600 transition-all">
                            <div className="flex items-start gap-3">
                              <div className="relative">
                                <img src={video.thumbnail} alt={video.title} className="w-16 h-12 object-cover rounded flex-shrink-0" />
                                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 rounded">
                                  <div className="bg-red-600 text-white rounded-full p-1">
                                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                                      <path d="M8 5v14l11-7z" />
                                    </svg>
                                  </div>
                                </div>
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="font-medium text-gray-900 dark:text-white text-sm line-clamp-2">{video.title}</h4>
                                <p className="text-xs text-red-600 dark:text-red-400 mt-1">{video.channelTitle}</p>
                                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">{video.description}</p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-2">{message.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
              {message.type === 'user' && (
                <div className="w-8 h-8 rounded-full border border-gray-300 dark:border-gray-600 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </div>
              )}
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full border border-gray-300 dark:border-gray-600 flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-gray-600 dark:text-gray-400" />
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl p-3">
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <div className="relative">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="输入您想搜索的影视或视频内容..."
              className="w-full p-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 dark:bg-gray-700 text-sm resize-none"
              rows={1}
              disabled={isLoading}
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isLoading}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 flex items-center justify-center transition-colors"
            >
              <Send className="w-4 h-4 text-white" />
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">点击推荐卡片可跳转搜索</p>
        </div>
      </div>
    </div>
  );

  // 使用 Portal 将弹窗渲染到 document.body
  return createPortal(modalContent, document.body);
};

export default AIChatModal;
