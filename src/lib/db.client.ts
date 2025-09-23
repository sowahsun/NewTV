/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function */
'use client';

/**
 * 仅在浏览器端使用的数据库工具，目前基于 localStorage 实现。
 * 之所以单独拆分文件，是为了避免在客户端 bundle 中引入 `fs`, `path` 等 Node.js 内置模块，
 * 从而解决诸如 "Module not found: Can't resolve 'fs'" 的问题。
 *
 * 功能：
 * 1. 获取全部播放记录（getAllPlayRecords）。
 * 2. 保存播放记录（savePlayRecord）。
 * 3. 数据库存储模式下的混合缓存策略，提升用户体验。
 *
 * 如后续需要在客户端读取收藏等其它数据，可按同样方式在此文件中补充实现。
 */

import { getAuthInfoFromBrowserCookie } from './auth';
import { SkipConfig } from './types';

// 全局错误触发函数
function triggerGlobalError(message: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('globalError', {
        detail: { message },
      })
    );
  }
}

// ---- 类型 ----
export interface PlayRecord {
  title: string;
  source_name: string;
  year: string;
  cover: string;
  index: number; // 第几集
  total_episodes: number; // 总集数
  play_time: number; // 播放进度（秒）
  total_time: number; // 总进度（秒）
  save_time: number; // 记录保存时间（时间戳）
  search_title?: string; // 搜索时使用的标题
}

// ---- 用户统计数据类型 ----
export interface UserStats {
  totalWatchTime: number; // 总观看时长（秒）
  totalMovies: number; // 观看影片总数
  firstWatchDate: number; // 首次观看时间戳
  lastUpdateTime: number; // 最后更新时间戳
}

// ---- 收藏类型 ----
export interface Favorite {
  title: string;
  source_name: string;
  year: string;
  cover: string;
  total_episodes: number;
  save_time: number;
  search_title?: string;
  origin?: 'vod' | 'live';
}

// ---- 缓存数据结构 ----
interface CacheData<T> {
  data: T;
  timestamp: number;
  version: string;
}

interface UserCacheStore {
  playRecords?: CacheData<Record<string, PlayRecord>>;
  favorites?: CacheData<Record<string, Favorite>>;
  searchHistory?: CacheData<string[]>;
  skipConfigs?: CacheData<Record<string, SkipConfig>>;
  userStats?: CacheData<UserStats>; // 添加用户统计数据缓存
  // 新增豆瓣数据缓存
  doubanDetails?: CacheData<Record<string, any>>;
  doubanLists?: CacheData<Record<string, any>>;
}

// ---- 常量 ----
const PLAY_RECORDS_KEY = 'moontv_play_records';
const FAVORITES_KEY = 'moontv_favorites';
const SEARCH_HISTORY_KEY = 'moontv_search_history';
const USER_STATS_KEY = 'moontv_user_stats'; // 添加用户统计数据存储键

// ---- 缓存相关常量 ----
const CACHE_PREFIX = 'moontv_cache_';
const CACHE_VERSION = '1.0.0';
const CACHE_EXPIRE_TIME = 60 * 60 * 1000; // 一小时缓存过期

// 豆瓣数据专用缓存过期时间
const DOUBAN_CACHE_EXPIRE = {
  details: 4 * 60 * 60 * 1000,  // 详情4小时（变化较少）
  lists: 2 * 60 * 60 * 1000,   // 列表2小时（更新频繁）
};

// ---- 环境变量 ----
const STORAGE_TYPE = (() => {
  const raw =
    (typeof window !== 'undefined' &&
      (window as any).RUNTIME_CONFIG?.STORAGE_TYPE) ||
    (process.env.STORAGE_TYPE as
      | 'localstorage'
      | 'redis'
      | 'upstash'
      | undefined) ||
    'localstorage';
  return raw;
})();

// ---------------- 搜索历史相关常量 ----------------
// 搜索历史最大保存条数
const SEARCH_HISTORY_LIMIT = 20;

// ---- 缓存管理器 ----
class HybridCacheManager {
  private static instance: HybridCacheManager;

  static getInstance(): HybridCacheManager {
    if (!HybridCacheManager.instance) {
      HybridCacheManager.instance = new HybridCacheManager();
    }
    return HybridCacheManager.instance;
  }

  /**
   * 获取当前用户名
   */
  private getCurrentUsername(): string | null {
    const authInfo = getAuthInfoFromBrowserCookie();
    return authInfo?.username || null;
  }

  /**
   * 生成用户专属的缓存key
   */
  private getUserCacheKey(username: string): string {
    return `${CACHE_PREFIX}${username}`;
  }

  /**
   * 获取用户缓存数据
   */
  private getUserCache(username: string): UserCacheStore {
    if (typeof window === 'undefined') return {};

    try {
      const cacheKey = this.getUserCacheKey(username);
      const cached = localStorage.getItem(cacheKey);
      return cached ? JSON.parse(cached) : {};
    } catch (error) {
      console.warn('获取用户缓存失败:', error);
      return {};
    }
  }

  /**
   * 保存用户缓存数据
   */
  private saveUserCache(username: string, cache: UserCacheStore): void {
    if (typeof window === 'undefined') return;

    try {
      // 检查缓存大小，超过15MB时清理旧数据
      const cacheSize = JSON.stringify(cache).length;
      if (cacheSize > 15 * 1024 * 1024) {
        console.warn('缓存过大，清理旧数据');
        this.cleanOldCache(cache);
      }

      const cacheKey = this.getUserCacheKey(username);
      localStorage.setItem(cacheKey, JSON.stringify(cache));
    } catch (error) {
      console.warn('保存用户缓存失败:', error);
      // 存储空间不足时清理缓存后重试
      if (
        error instanceof DOMException &&
        error.name === 'QuotaExceededError'
      ) {
        this.clearAllCache();
        try {
          const cacheKey = this.getUserCacheKey(username);
          localStorage.setItem(cacheKey, JSON.stringify(cache));
        } catch (retryError) {
          console.error('重试保存缓存仍然失败:', retryError);
        }
      }
    }
  }

  /**
   * 清理过期缓存数据
   */
  private cleanOldCache(cache: UserCacheStore): void {
    const now = Date.now();
    const maxAge = 60 * 24 * 60 * 60 * 1000; // 两个月

    // 清理过期的播放记录缓存
    if (cache.playRecords && now - cache.playRecords.timestamp > maxAge) {
      delete cache.playRecords;
    }

    // 清理过期的收藏缓存
    if (cache.favorites && now - cache.favorites.timestamp > maxAge) {
      delete cache.favorites;
    }

    // 清理过期的豆瓣详情缓存
    if (cache.doubanDetails && now - cache.doubanDetails.timestamp > DOUBAN_CACHE_EXPIRE.details) {
      delete cache.doubanDetails;
    }

    // 清理过期的豆瓣列表缓存
    if (cache.doubanLists && now - cache.doubanLists.timestamp > DOUBAN_CACHE_EXPIRE.lists) {
      delete cache.doubanLists;
    }
  }

  /**
   * 清理所有缓存
   */
  private clearAllCache(): void {
    const keys = Object.keys(localStorage);
    keys.forEach((key) => {
      if (key.startsWith('moontv_cache_')) {
        localStorage.removeItem(key);
      }
    });
  }

  /**
   * 检查缓存是否有效
   */
  private isCacheValid<T>(cache: CacheData<T>): boolean {
    const now = Date.now();
    return (
      cache.version === CACHE_VERSION &&
      now - cache.timestamp < CACHE_EXPIRE_TIME
    );
  }

  /**
   * 创建缓存数据
   */
  private createCacheData<T>(data: T): CacheData<T> {
    return {
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };
  }

  /**
   * 获取缓存的播放记录
   */
  getCachedPlayRecords(): Record<string, PlayRecord> | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.playRecords;

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    return null;
  }

  /**
   * 缓存播放记录
   */
  cachePlayRecords(data: Record<string, PlayRecord>): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);
    userCache.playRecords = this.createCacheData(data);
    this.saveUserCache(username, userCache);
  }

  /**
   * 获取缓存的收藏
   */
  getCachedFavorites(): Record<string, Favorite> | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.favorites;

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    return null;
  }

  /**
   * 缓存收藏
   */
  cacheFavorites(data: Record<string, Favorite>): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);
    userCache.favorites = this.createCacheData(data);
    this.saveUserCache(username, userCache);
  }

  /**
   * 获取缓存的搜索历史
   */
  getCachedSearchHistory(): string[] | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.searchHistory;

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    return null;
  }

  /**
   * 缓存搜索历史
   */
  cacheSearchHistory(data: string[]): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);
    userCache.searchHistory = this.createCacheData(data);
    this.saveUserCache(username, userCache);
  }

  /**
   * 获取缓存的跳过片头片尾配置
   */
  getCachedSkipConfigs(): Record<string, SkipConfig> | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.skipConfigs;

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    return null;
  }

  /**
   * 缓存跳过片头片尾配置
   */
  cacheSkipConfigs(data: Record<string, SkipConfig>): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);
    userCache.skipConfigs = this.createCacheData(data);
    this.saveUserCache(username, userCache);
  }

  /**
   * 获取缓存的用户统计数据
   */
  getCachedUserStats(): UserStats | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.userStats;

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    return null;
  }

  /**
   * 缓存用户统计数据
   */
  cacheUserStats(data: UserStats): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);
    userCache.userStats = this.createCacheData(data);
    this.saveUserCache(username, userCache);
  }

  /**
   * 清除指定用户的所有缓存
   */
  clearUserCache(username?: string): void {
    const targetUsername = username || this.getCurrentUsername();
    if (!targetUsername) return;

    try {
      const cacheKey = this.getUserCacheKey(targetUsername);
      localStorage.removeItem(cacheKey);
    } catch (error) {
      console.warn('清除用户缓存失败:', error);
    }
  }

  /**
   * 清除所有过期缓存
   */
  clearExpiredCaches(): void {
    if (typeof window === 'undefined') return;

    try {
      const keysToRemove: string[] = [];

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) {
          try {
            const cache = JSON.parse(localStorage.getItem(key) || '{}');
            // 检查是否有任何缓存数据过期
            let hasValidData = false;
            for (const [, cacheData] of Object.entries(cache)) {
              if (cacheData && this.isCacheValid(cacheData as CacheData<any>)) {
                hasValidData = true;
                break;
              }
            }
            if (!hasValidData) {
              keysToRemove.push(key);
            }
          } catch {
            // 解析失败的缓存也删除
            keysToRemove.push(key);
          }
        }
      }

      keysToRemove.forEach((key) => localStorage.removeItem(key));
    } catch (error) {
      console.warn('清除过期缓存失败:', error);
    }
  }

  // ---- 豆瓣数据缓存方法 ----

  /**
   * 检查豆瓣缓存是否有效（使用专门的过期时间）
   */
  private isDoubanCacheValid<T>(cache: CacheData<T>, type: 'details' | 'lists'): boolean {
    const now = Date.now();
    const expireTime = type === 'details' ? DOUBAN_CACHE_EXPIRE.details : DOUBAN_CACHE_EXPIRE.lists;
    return (
      cache.version === CACHE_VERSION &&
      now - cache.timestamp < expireTime
    );
  }

  /**
   * 获取豆瓣详情缓存
   */
  getDoubanDetails(id: string): any | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.doubanDetails;

    if (cached && this.isDoubanCacheValid(cached, 'details')) {
      return cached.data[id] || null;
    }
    return null;
  }

  /**
   * 保存豆瓣详情缓存
   */
  setDoubanDetails(id: string, data: any): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);

    if (!userCache.doubanDetails) {
      userCache.doubanDetails = {
        data: {},
        timestamp: Date.now(),
        version: CACHE_VERSION
      };
    }

    userCache.doubanDetails.data[id] = data;
    userCache.doubanDetails.timestamp = Date.now();

    this.saveUserCache(username, userCache);
  }

  /**
   * 获取豆瓣列表缓存
   */
  getDoubanList(cacheKey: string): any | null {
    const username = this.getCurrentUsername();
    if (!username) return null;

    const userCache = this.getUserCache(username);
    const cached = userCache.doubanLists;

    if (cached && this.isDoubanCacheValid(cached, 'lists')) {
      return cached.data[cacheKey] || null;
    }
    return null;
  }

  /**
   * 保存豆瓣列表缓存
   */
  setDoubanList(cacheKey: string, data: any): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);

    if (!userCache.doubanLists) {
      userCache.doubanLists = {
        data: {},
        timestamp: Date.now(),
        version: CACHE_VERSION
      };
    }

    userCache.doubanLists.data[cacheKey] = data;
    userCache.doubanLists.timestamp = Date.now();

    this.saveUserCache(username, userCache);
  }

  /**
   * 生成豆瓣列表缓存键
   */
  static generateDoubanListKey(type: string, tag: string, pageStart: number, pageSize: number): string {
    return `${type}:${tag}:${pageStart}:${pageSize}`;
  }

  /**
   * 清除豆瓣缓存
   */
  clearDoubanCache(): void {
    const username = this.getCurrentUsername();
    if (!username) return;

    const userCache = this.getUserCache(username);
    delete userCache.doubanDetails;
    delete userCache.doubanLists;

    this.saveUserCache(username, userCache);
  }
}

// 获取缓存管理器实例
const cacheManager = HybridCacheManager.getInstance();

// ---- 错误处理辅助函数 ----
/**
 * 数据库操作失败时的通用错误处理
 * 立即从数据库刷新对应类型的缓存以保持数据一致性
 */
async function handleDatabaseOperationFailure(
  dataType: 'playRecords' | 'favorites' | 'searchHistory',
  error: any
): Promise<void> {
  console.error(`数据库操作失败 (${dataType}):`, error);
  triggerGlobalError(`数据库操作失败`);

  try {
    let freshData: any;
    let eventName: string;

    switch (dataType) {
      case 'playRecords':
        freshData = await fetchFromApi<Record<string, PlayRecord>>(
          `/api/playrecords`
        );
        cacheManager.cachePlayRecords(freshData);
        eventName = 'playRecordsUpdated';
        break;
      case 'favorites':
        freshData = await fetchFromApi<Record<string, Favorite>>(
          `/api/favorites`
        );
        cacheManager.cacheFavorites(freshData);
        eventName = 'favoritesUpdated';
        break;
      case 'searchHistory':
        freshData = await fetchFromApi<string[]>(`/api/searchhistory`);
        cacheManager.cacheSearchHistory(freshData);
        eventName = 'searchHistoryUpdated';
        break;
    }

    // 触发更新事件通知组件
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: freshData,
      })
    );
  } catch (refreshErr) {
    console.error(`刷新${dataType}缓存失败:`, refreshErr);
    triggerGlobalError(`刷新${dataType}缓存失败`);
  }
}

// 页面加载时清理过期缓存
if (typeof window !== 'undefined') {
  setTimeout(() => cacheManager.clearExpiredCaches(), 1000);
}

// ---- 工具函数 ----
/**
 * 通用的 fetch 函数，处理 401 状态码自动跳转登录
 */
async function fetchWithAuth(
  url: string,
  options?: RequestInit,
  retryCount = 0
): Promise<Response> {
  const res = await fetch(url, options);
  if (!res.ok) {
    // 如果是 401 未授权，先尝试重试一次（可能是新用户注册后的短暂认证延迟）
    if (res.status === 401) {
      console.log(`API ${url} 返回401错误，当前重试次数: ${retryCount}`);
      
      // 对于新用户或临时认证问题，给更多重试机会
      if (retryCount < 2) {
        const waitTime = retryCount === 0 ? 500 : 1000; // 第一次重试等待500ms，第二次等待1000ms
        console.log(`API ${url} 返回401，等待${waitTime}ms后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return fetchWithAuth(url, options, retryCount + 1);
      }

      // 检查当前是否在注册或登录页面，如果是则不要跳转
      const currentPath = window.location.pathname;
      if (currentPath === '/login' || currentPath === '/register') {
        console.log(`在${currentPath}页面收到401错误，不执行自动登出`);
        throw new Error(`请求 ${url} 失败: ${res.status}`);
      }

      // 检查是否是统计数据更新请求失败，如果是则不强制登出
      if (url.includes('/api/user/stats') && options?.method === 'POST') {
        console.warn(`统计数据更新请求失败 (${url})，但不强制登出用户`);
        throw new Error(`统计数据更新失败: ${res.status}`);
      }

      // 检查是否是获取播放记录请求失败（新用户可能没有记录），如果是则不强制登出
      if (url.includes('/api/playrecords') && options?.method !== 'POST' && options?.method !== 'DELETE') {
        console.warn(`获取播放记录请求失败 (${url})，可能是新用户，不强制登出`);
        throw new Error(`获取播放记录失败: ${res.status}`);
      }

      console.log(`多次重试后仍然401，执行登出流程`);
      
      // 调用 logout 接口
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('注销请求失败:', error);
      }
      const currentUrl = window.location.pathname + window.location.search;
      const loginUrl = new URL('/login', window.location.origin);
      loginUrl.searchParams.set('redirect', currentUrl);
      window.location.href = loginUrl.toString();
      throw new Error('用户未授权，已跳转到登录页面');
    }
    throw new Error(`请求 ${url} 失败: ${res.status}`);
  }
  return res;
}

async function fetchFromApi<T>(path: string): Promise<T> {
  const res = await fetchWithAuth(path);
  return (await res.json()) as T;
}

/**
 * 生成存储key
 */
export function generateStorageKey(source: string, id: string): string {
  return `${source}+${id}`;
}

// ---- API ----
/**
 * 读取全部播放记录。
 * 非本地存储模式下使用混合缓存策略：优先返回缓存数据，后台异步同步最新数据。
 * 在服务端渲染阶段 (window === undefined) 时返回空对象，避免报错。
 */
export async function getAllPlayRecords(): Promise<Record<string, PlayRecord>> {
  // 服务器端渲染阶段直接返回空，交由客户端 useEffect 再行请求
  if (typeof window === 'undefined') {
    return {};
  }

  // 数据库存储模式：使用混合缓存策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 优先从缓存获取数据
    const cachedData = cacheManager.getCachedPlayRecords();

    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, PlayRecord>>(`/api/playrecords`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cachePlayRecords(freshData);
            // 触发数据更新事件，供组件监听
            window.dispatchEvent(
              new CustomEvent('playRecordsUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步播放记录失败:', err);
          triggerGlobalError('后台同步播放记录失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, PlayRecord>>(
          `/api/playrecords`
        );
        cacheManager.cachePlayRecords(freshData);
        return freshData;
      } catch (err) {
        console.error('获取播放记录失败:', err);
        // 现在API已修复，新用户会返回200状态码和空对象，不再需要特殊处理401错误
        // 只有真正的网络错误或服务器错误才会触发全局错误提示
        if (err instanceof Error && (err.message.includes('获取播放记录失败: 401') || err.message.includes('获取播放记录失败: 500'))) {
          console.log('网络错误或服务器错误，返回空播放记录');
          return {};
        }
        // 对于其他错误，显示全局错误提示
        triggerGlobalError('获取播放记录失败');
        return {};
      }
    }
  }

  // localstorage 模式
  try {
    const raw = localStorage.getItem(PLAY_RECORDS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, PlayRecord>;
  } catch (err) {
    console.error('读取播放记录失败:', err);
    triggerGlobalError('读取播放记录失败');
    return {};
  }
}

/**
 * 保存播放记录。
 * 数据库存储模式下使用乐观更新：先更新缓存（立即生效），再异步同步到数据库。
 */
export async function savePlayRecord(
  source: string,
  id: string,
  record: PlayRecord
): Promise<void> {
  const key = generateStorageKey(source, id);

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedRecords = cacheManager.getCachedPlayRecords() || {};
    cachedRecords[key] = record;
    cacheManager.cachePlayRecords(cachedRecords);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('playRecordsUpdated', {
        detail: cachedRecords,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth('/api/playrecords', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key, record }),
      });

      // 更新用户统计数据
      await updateUserStats(record);

      // 触发用户统计数据更新事件
      window.dispatchEvent(
        new CustomEvent('userStatsUpdated', {
          detail: { record },
        })
      );
    } catch (err) {
      await handleDatabaseOperationFailure('playRecords', err);
      triggerGlobalError('保存播放记录失败');
      throw err;
    }
    return;
  }

  // localstorage 模式
  if (typeof window === 'undefined') {
    console.warn('无法在服务端保存播放记录到 localStorage');
    return;
  }

  try {
    const allRecords = await getAllPlayRecords();
    allRecords[key] = record;
    localStorage.setItem(PLAY_RECORDS_KEY, JSON.stringify(allRecords));
    window.dispatchEvent(
      new CustomEvent('playRecordsUpdated', {
        detail: allRecords,
      })
    );

    // 更新用户统计数据
    await updateUserStats(record);

    // 触发用户统计数据更新事件
    window.dispatchEvent(
      new CustomEvent('userStatsUpdated', {
        detail: { record },
      })
    );
  } catch (err) {
    console.error('保存播放记录失败:', err);
    triggerGlobalError('保存播放记录失败');
    throw err;
  }
}

/**
 * 删除播放记录。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function deletePlayRecord(
  source: string,
  id: string
): Promise<void> {
  const key = generateStorageKey(source, id);
  console.log('开始删除播放记录:', { source, id, key });

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    console.log('使用数据库存储模式删除记录');
    
    // 立即更新缓存
    const cachedRecords = cacheManager.getCachedPlayRecords() || {};
    console.log('删除前缓存记录数量:', Object.keys(cachedRecords).length);
    console.log('要删除的记录是否存在于缓存:', key in cachedRecords);
    
    delete cachedRecords[key];
    cacheManager.cachePlayRecords(cachedRecords);
    console.log('删除后缓存记录数量:', Object.keys(cachedRecords).length);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('playRecordsUpdated', {
        detail: cachedRecords,
      })
    );
    console.log('已触发playRecordsUpdated事件');

    // 异步同步到数据库
    try {
      const deleteUrl = `/api/playrecords?key=${encodeURIComponent(key)}`;
      console.log('发送删除请求到:', deleteUrl);
      
      const response = await fetchWithAuth(deleteUrl, {
        method: 'DELETE',
      });
      
      console.log('删除请求响应状态:', response.status);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('删除请求失败:', errorText);
        throw new Error(`删除请求失败: ${response.status} ${errorText}`);
      }
      
      console.log('数据库删除操作成功完成');
    } catch (err) {
      console.error('数据库删除操作失败:', err);
      await handleDatabaseOperationFailure('playRecords', err);
      triggerGlobalError('删除播放记录失败');
      throw err;
    }
    return;
  }

  // localstorage 模式
  if (typeof window === 'undefined') {
    console.warn('无法在服务端删除播放记录到 localStorage');
    return;
  }

  try {
    const allRecords = await getAllPlayRecords();
    delete allRecords[key];
    localStorage.setItem(PLAY_RECORDS_KEY, JSON.stringify(allRecords));
    window.dispatchEvent(
      new CustomEvent('playRecordsUpdated', {
        detail: allRecords,
      })
    );
  } catch (err) {
    console.error('删除播放记录失败:', err);
    triggerGlobalError('删除播放记录失败');
    throw err;
  }
}

/* ---------------- 搜索历史相关 API ---------------- */

/**
 * 获取搜索历史。
 * 数据库存储模式下使用混合缓存策略：优先返回缓存数据，后台异步同步最新数据。
 */
export async function getSearchHistory(): Promise<string[]> {
  // 服务器端渲染阶段直接返回空
  if (typeof window === 'undefined') {
    return [];
  }

  // 数据库存储模式：使用混合缓存策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 优先从缓存获取数据
    const cachedData = cacheManager.getCachedSearchHistory();

    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<string[]>(`/api/searchhistory`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cacheSearchHistory(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('searchHistoryUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步搜索历史失败:', err);
          triggerGlobalError('后台同步搜索历史失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<string[]>(`/api/searchhistory`);
        cacheManager.cacheSearchHistory(freshData);
        return freshData;
      } catch (err) {
        console.error('获取搜索历史失败:', err);
        triggerGlobalError('获取搜索历史失败');
        return [];
      }
    }
  }

  // localStorage 模式
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as string[];
    // 仅返回字符串数组
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error('读取搜索历史失败:', err);
    triggerGlobalError('读取搜索历史失败');
    return [];
  }
}

/**
 * 将关键字添加到搜索历史。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function addSearchHistory(keyword: string): Promise<void> {
  const trimmed = keyword.trim();
  if (!trimmed) return;

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedHistory = cacheManager.getCachedSearchHistory() || [];
    const newHistory = [trimmed, ...cachedHistory.filter((k) => k !== trimmed)];
    // 限制长度
    if (newHistory.length > SEARCH_HISTORY_LIMIT) {
      newHistory.length = SEARCH_HISTORY_LIMIT;
    }
    cacheManager.cacheSearchHistory(newHistory);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('searchHistoryUpdated', {
        detail: newHistory,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth('/api/searchhistory', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ keyword: trimmed }),
      });
    } catch (err) {
      await handleDatabaseOperationFailure('searchHistory', err);
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') return;

  try {
    const history = await getSearchHistory();
    const newHistory = [trimmed, ...history.filter((k) => k !== trimmed)];
    // 限制长度
    if (newHistory.length > SEARCH_HISTORY_LIMIT) {
      newHistory.length = SEARCH_HISTORY_LIMIT;
    }
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(newHistory));
    window.dispatchEvent(
      new CustomEvent('searchHistoryUpdated', {
        detail: newHistory,
      })
    );
  } catch (err) {
    console.error('保存搜索历史失败:', err);
    triggerGlobalError('保存搜索历史失败');
  }
}

/**
 * 清空搜索历史。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function clearSearchHistory(): Promise<void> {
  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    cacheManager.cacheSearchHistory([]);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('searchHistoryUpdated', {
        detail: [],
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth(`/api/searchhistory`, {
        method: 'DELETE',
      });
    } catch (err) {
      await handleDatabaseOperationFailure('searchHistory', err);
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SEARCH_HISTORY_KEY);
  window.dispatchEvent(
    new CustomEvent('searchHistoryUpdated', {
      detail: [],
    })
  );
}

/**
 * 删除单条搜索历史。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function deleteSearchHistory(keyword: string): Promise<void> {
  const trimmed = keyword.trim();
  if (!trimmed) return;

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedHistory = cacheManager.getCachedSearchHistory() || [];
    const newHistory = cachedHistory.filter((k) => k !== trimmed);
    cacheManager.cacheSearchHistory(newHistory);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('searchHistoryUpdated', {
        detail: newHistory,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth(
        `/api/searchhistory?keyword=${encodeURIComponent(trimmed)}`,
        {
          method: 'DELETE',
        }
      );
    } catch (err) {
      await handleDatabaseOperationFailure('searchHistory', err);
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') return;

  try {
    const history = await getSearchHistory();
    const newHistory = history.filter((k) => k !== trimmed);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(newHistory));
    window.dispatchEvent(
      new CustomEvent('searchHistoryUpdated', {
        detail: newHistory,
      })
    );
  } catch (err) {
    console.error('删除搜索历史失败:', err);
    triggerGlobalError('删除搜索历史失败');
  }
}

// ---------------- 收藏相关 API ----------------

/**
 * 获取全部收藏。
 * 数据库存储模式下使用混合缓存策略：优先返回缓存数据，后台异步同步最新数据。
 */
export async function getAllFavorites(): Promise<Record<string, Favorite>> {
  // 服务器端渲染阶段直接返回空
  if (typeof window === 'undefined') {
    return {};
  }

  // 数据库存储模式：使用混合缓存策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 优先从缓存获取数据
    const cachedData = cacheManager.getCachedFavorites();

    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, Favorite>>(`/api/favorites`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cacheFavorites(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('favoritesUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步收藏失败:', err);
          triggerGlobalError('后台同步收藏失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, Favorite>>(
          `/api/favorites`
        );
        cacheManager.cacheFavorites(freshData);
        return freshData;
      } catch (err) {
        console.error('获取收藏失败:', err);
        triggerGlobalError('获取收藏失败');
        return {};
      }
    }
  }

  // localStorage 模式
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, Favorite>;
  } catch (err) {
    console.error('读取收藏失败:', err);
    triggerGlobalError('读取收藏失败');
    return {};
  }
}

/**
 * 保存收藏。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function saveFavorite(
  source: string,
  id: string,
  favorite: Favorite
): Promise<void> {
  const key = generateStorageKey(source, id);

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedFavorites = cacheManager.getCachedFavorites() || {};
    cachedFavorites[key] = favorite;
    cacheManager.cacheFavorites(cachedFavorites);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('favoritesUpdated', {
        detail: cachedFavorites,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth('/api/favorites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key, favorite }),
      });
    } catch (err) {
      await handleDatabaseOperationFailure('favorites', err);
      triggerGlobalError('保存收藏失败');
      throw err;
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') {
    console.warn('无法在服务端保存收藏到 localStorage');
    return;
  }

  try {
    const allFavorites = await getAllFavorites();
    allFavorites[key] = favorite;
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(allFavorites));
    window.dispatchEvent(
      new CustomEvent('favoritesUpdated', {
        detail: allFavorites,
      })
    );
  } catch (err) {
    console.error('保存收藏失败:', err);
    triggerGlobalError('保存收藏失败');
    throw err;
  }
}

/**
 * 删除收藏。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function deleteFavorite(
  source: string,
  id: string
): Promise<void> {
  const key = generateStorageKey(source, id);

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedFavorites = cacheManager.getCachedFavorites() || {};
    delete cachedFavorites[key];
    cacheManager.cacheFavorites(cachedFavorites);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('favoritesUpdated', {
        detail: cachedFavorites,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth(`/api/favorites?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      await handleDatabaseOperationFailure('favorites', err);
      triggerGlobalError('删除收藏失败');
      throw err;
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') {
    console.warn('无法在服务端删除收藏到 localStorage');
    return;
  }

  try {
    const allFavorites = await getAllFavorites();
    delete allFavorites[key];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(allFavorites));
    window.dispatchEvent(
      new CustomEvent('favoritesUpdated', {
        detail: allFavorites,
      })
    );
  } catch (err) {
    console.error('删除收藏失败:', err);
    triggerGlobalError('删除收藏失败');
    throw err;
  }
}

/**
 * 判断是否已收藏。
 * 数据库存储模式下使用混合缓存策略：优先返回缓存数据，后台异步同步最新数据。
 */
export async function isFavorited(
  source: string,
  id: string
): Promise<boolean> {
  const key = generateStorageKey(source, id);

  // 数据库存储模式：使用混合缓存策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    const cachedFavorites = cacheManager.getCachedFavorites();

    if (cachedFavorites) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, Favorite>>(`/api/favorites`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedFavorites) !== JSON.stringify(freshData)) {
            cacheManager.cacheFavorites(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('favoritesUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步收藏失败:', err);
          triggerGlobalError('后台同步收藏失败');
        });

      return !!cachedFavorites[key];
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, Favorite>>(
          `/api/favorites`
        );
        cacheManager.cacheFavorites(freshData);
        return !!freshData[key];
      } catch (err) {
        console.error('检查收藏状态失败:', err);
        triggerGlobalError('检查收藏状态失败');
        return false;
      }
    }
  }

  // localStorage 模式
  const allFavorites = await getAllFavorites();
  return !!allFavorites[key];
}

/**
 * 清空全部播放记录
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function clearAllPlayRecords(): Promise<void> {
  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    cacheManager.cachePlayRecords({});

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('playRecordsUpdated', {
        detail: {},
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth(`/api/playrecords`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      await handleDatabaseOperationFailure('playRecords', err);
      triggerGlobalError('清空播放记录失败');
      throw err;
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') return;
  localStorage.removeItem(PLAY_RECORDS_KEY);
  window.dispatchEvent(
    new CustomEvent('playRecordsUpdated', {
      detail: {},
    })
  );
}

/**
 * 清空全部收藏
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function clearAllFavorites(): Promise<void> {
  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    cacheManager.cacheFavorites({});

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('favoritesUpdated', {
        detail: {},
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth(`/api/favorites`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      await handleDatabaseOperationFailure('favorites', err);
      triggerGlobalError('清空收藏失败');
      throw err;
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') return;
  localStorage.removeItem(FAVORITES_KEY);
  window.dispatchEvent(
    new CustomEvent('favoritesUpdated', {
      detail: {},
    })
  );
}

// ---------------- 混合缓存辅助函数 ----------------

/**
 * 清除当前用户的所有缓存数据
 * 用于用户登出时清理缓存
 */
export function clearUserCache(): void {
  if (STORAGE_TYPE !== 'localstorage') {
    cacheManager.clearUserCache();
  }
}

/**
 * 手动刷新所有缓存数据
 * 强制从服务器重新获取数据并更新缓存
 */
export async function refreshAllCache(): Promise<void> {
  if (STORAGE_TYPE === 'localstorage') return;

  try {
    // 并行刷新所有数据
    const [playRecords, favorites, searchHistory, skipConfigs] =
      await Promise.allSettled([
        fetchFromApi<Record<string, PlayRecord>>(`/api/playrecords`),
        fetchFromApi<Record<string, Favorite>>(`/api/favorites`),
        fetchFromApi<string[]>(`/api/searchhistory`),
        fetchFromApi<Record<string, SkipConfig>>(`/api/skipconfigs`),
      ]);

    if (playRecords.status === 'fulfilled') {
      cacheManager.cachePlayRecords(playRecords.value);
      window.dispatchEvent(
        new CustomEvent('playRecordsUpdated', {
          detail: playRecords.value,
        })
      );
    }

    if (favorites.status === 'fulfilled') {
      cacheManager.cacheFavorites(favorites.value);
      window.dispatchEvent(
        new CustomEvent('favoritesUpdated', {
          detail: favorites.value,
        })
      );
    }

    if (searchHistory.status === 'fulfilled') {
      cacheManager.cacheSearchHistory(searchHistory.value);
      window.dispatchEvent(
        new CustomEvent('searchHistoryUpdated', {
          detail: searchHistory.value,
        })
      );
    }

    if (skipConfigs.status === 'fulfilled') {
      cacheManager.cacheSkipConfigs(skipConfigs.value);
      window.dispatchEvent(
        new CustomEvent('skipConfigsUpdated', {
          detail: skipConfigs.value,
        })
      );
    }
  } catch (err) {
    console.error('刷新缓存失败:', err);
    triggerGlobalError('刷新缓存失败');
  }
}



/**
 * 预加载所有用户数据到缓存
 * 适合在应用启动时调用，提升后续访问速度
 */
export async function preloadUserData(): Promise<void> {
  if (STORAGE_TYPE === 'localstorage') return;

  // 检查是否已有有效缓存，避免重复请求
  const status = getCacheStatus();
  if (
    status.hasPlayRecords &&
    status.hasFavorites &&
    status.hasSearchHistory &&
    status.hasSkipConfigs
  ) {
    return;
  }

  // 后台静默预加载，不阻塞界面
  refreshAllCache().catch((err) => {
    console.warn('预加载用户数据失败:', err);
    triggerGlobalError('预加载用户数据失败');
  });
}

// ---------------- 跳过片头片尾配置相关 API ----------------

/**
 * 获取跳过片头片尾配置。
 * 数据库存储模式下使用混合缓存策略：优先返回缓存数据，后台异步同步最新数据。
 */
export async function getSkipConfig(
  source: string,
  id: string
): Promise<SkipConfig | null> {
  // 服务器端渲染阶段直接返回空
  if (typeof window === 'undefined') {
    return null;
  }

  const key = generateStorageKey(source, id);

  // 数据库存储模式：使用混合缓存策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 优先从缓存获取数据
    const cachedData = cacheManager.getCachedSkipConfigs();

    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, SkipConfig>>(`/api/skipconfigs`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cacheSkipConfigs(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('skipConfigsUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步跳过片头片尾配置失败:', err);
        });

      return cachedData[key] || null;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, SkipConfig>>(
          `/api/skipconfigs`
        );
        cacheManager.cacheSkipConfigs(freshData);
        return freshData[key] || null;
      } catch (err) {
        console.error('获取跳过片头片尾配置失败:', err);
        triggerGlobalError('获取跳过片头片尾配置失败');
        return null;
      }
    }
  }

  // localStorage 模式
  try {
    const raw = localStorage.getItem('moontv_skip_configs');
    if (!raw) return null;
    const configs = JSON.parse(raw) as Record<string, SkipConfig>;
    return configs[key] || null;
  } catch (err) {
    console.error('读取跳过片头片尾配置失败:', err);
    triggerGlobalError('读取跳过片头片尾配置失败');
    return null;
  }
}

/**
 * 保存跳过片头片尾配置。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function saveSkipConfig(
  source: string,
  id: string,
  config: SkipConfig
): Promise<void> {
  const key = generateStorageKey(source, id);

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedConfigs = cacheManager.getCachedSkipConfigs() || {};
    cachedConfigs[key] = config;
    cacheManager.cacheSkipConfigs(cachedConfigs);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('skipConfigsUpdated', {
        detail: cachedConfigs,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth('/api/skipconfigs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key, config }),
      });
    } catch (err) {
      console.error('保存跳过片头片尾配置失败:', err);
      triggerGlobalError('保存跳过片头片尾配置失败');
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') {
    console.warn('无法在服务端保存跳过片头片尾配置到 localStorage');
    return;
  }

  try {
    const raw = localStorage.getItem('moontv_skip_configs');
    const configs = raw ? (JSON.parse(raw) as Record<string, SkipConfig>) : {};
    configs[key] = config;
    localStorage.setItem('moontv_skip_configs', JSON.stringify(configs));
    window.dispatchEvent(
      new CustomEvent('skipConfigsUpdated', {
        detail: configs,
      })
    );
  } catch (err) {
    console.error('保存跳过片头片尾配置失败:', err);
    triggerGlobalError('保存跳过片头片尾配置失败');
    throw err;
  }
}

/**
 * 获取所有跳过片头片尾配置。
 * 数据库存储模式下使用混合缓存策略：优先返回缓存数据，后台异步同步最新数据。
 */
export async function getAllSkipConfigs(): Promise<Record<string, SkipConfig>> {
  // 服务器端渲染阶段直接返回空
  if (typeof window === 'undefined') {
    return {};
  }

  // 数据库存储模式：使用混合缓存策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 优先从缓存获取数据
    const cachedData = cacheManager.getCachedSkipConfigs();

    if (cachedData) {
      // 返回缓存数据，同时后台异步更新
      fetchFromApi<Record<string, SkipConfig>>(`/api/skipconfigs`)
        .then((freshData) => {
          // 只有数据真正不同时才更新缓存
          if (JSON.stringify(cachedData) !== JSON.stringify(freshData)) {
            cacheManager.cacheSkipConfigs(freshData);
            // 触发数据更新事件
            window.dispatchEvent(
              new CustomEvent('skipConfigsUpdated', {
                detail: freshData,
              })
            );
          }
        })
        .catch((err) => {
          console.warn('后台同步跳过片头片尾配置失败:', err);
          triggerGlobalError('后台同步跳过片头片尾配置失败');
        });

      return cachedData;
    } else {
      // 缓存为空，直接从 API 获取并缓存
      try {
        const freshData = await fetchFromApi<Record<string, SkipConfig>>(
          `/api/skipconfigs`
        );
        cacheManager.cacheSkipConfigs(freshData);
        return freshData;
      } catch (err) {
        console.error('获取跳过片头片尾配置失败:', err);
        triggerGlobalError('获取跳过片头片尾配置失败');
        return {};
      }
    }
  }

  // localStorage 模式
  try {
    const raw = localStorage.getItem('moontv_skip_configs');
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, SkipConfig>;
  } catch (err) {
    console.error('读取跳过片头片尾配置失败:', err);
    triggerGlobalError('读取跳过片头片尾配置失败');
    return {};
  }
}

/**
 * 删除跳过片头片尾配置。
 * 数据库存储模式下使用乐观更新：先更新缓存，再异步同步到数据库。
 */
export async function deleteSkipConfig(
  source: string,
  id: string
): Promise<void> {
  const key = generateStorageKey(source, id);

  // 数据库存储模式：乐观更新策略（包括 redis 和 upstash）
  if (STORAGE_TYPE !== 'localstorage') {
    // 立即更新缓存
    const cachedConfigs = cacheManager.getCachedSkipConfigs() || {};
    delete cachedConfigs[key];
    cacheManager.cacheSkipConfigs(cachedConfigs);

    // 触发立即更新事件
    window.dispatchEvent(
      new CustomEvent('skipConfigsUpdated', {
        detail: cachedConfigs,
      })
    );

    // 异步同步到数据库
    try {
      await fetchWithAuth(`/api/skipconfigs?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      console.error('删除跳过片头片尾配置失败:', err);
      triggerGlobalError('删除跳过片头片尾配置失败');
    }
    return;
  }

  // localStorage 模式
  if (typeof window === 'undefined') {
    console.warn('无法在服务端删除跳过片头片尾配置到 localStorage');
    return;
  }

  try {
    const raw = localStorage.getItem('moontv_skip_configs');
    if (raw) {
      const configs = JSON.parse(raw) as Record<string, SkipConfig>;
      delete configs[key];
      localStorage.setItem('moontv_skip_configs', JSON.stringify(configs));
      window.dispatchEvent(
        new CustomEvent('skipConfigsUpdated', {
          detail: configs,
        })
      );
    }
  } catch (err) {
    console.error('删除跳过片头片尾配置失败:', err);
    triggerGlobalError('删除跳过片头片尾配置失败');
    throw err;
  }
}

// ---- 豆瓣数据缓存导出函数 ----

/**
 * 获取豆瓣详情缓存
 * @param id 豆瓣ID
 * @returns 缓存的详情数据或null
 */
export function getDoubanDetailsCache(id: string): any | null {
  return cacheManager.getDoubanDetails(id);
}

/**
 * 保存豆瓣详情缓存
 * @param id 豆瓣ID
 * @param data 详情数据
 */
export function setDoubanDetailsCache(id: string, data: any): void {
  cacheManager.setDoubanDetails(id, data);
}

/**
 * 获取豆瓣列表缓存
 * @param type 类型 (tv/movie)
 * @param tag 标签
 * @param pageStart 页面起始位置
 * @param pageSize 页面大小
 * @returns 缓存的列表数据或null
 */
export function getDoubanListCache(type: string, tag: string, pageStart: number, pageSize: number): any | null {
  const cacheKey = HybridCacheManager.generateDoubanListKey(type, tag, pageStart, pageSize);
  return cacheManager.getDoubanList(cacheKey);
}

/**
 * 保存豆瓣列表缓存
 * @param type 类型 (tv/movie) 
 * @param tag 标签
 * @param pageStart 页面起始位置
 * @param pageSize 页面大小
 * @param data 列表数据
 */
export function setDoubanListCache(type: string, tag: string, pageStart: number, pageSize: number, data: any): void {
  const cacheKey = HybridCacheManager.generateDoubanListKey(type, tag, pageStart, pageSize);
  cacheManager.setDoubanList(cacheKey, data);
}

/**
 * 清除所有豆瓣缓存
 */
export function clearDoubanCache(): void {
  cacheManager.clearDoubanCache();
}

/**
 * 获取用户统计数据
 */
export async function getUserStats(forceRefresh = false): Promise<UserStats> {
  try {
    // 如果强制刷新，清除缓存
    if (forceRefresh) {
      const authInfo = getAuthInfoFromBrowserCookie();
      if (authInfo?.username) {
        cacheManager.clearUserCache(authInfo.username);
      }
    }

    // 先尝试从缓存获取
    const cached = cacheManager.getCachedUserStats();
    if (cached && !forceRefresh) {
      return cached;
    }

    // 从服务器获取
    const response = await fetchWithAuth('/api/user/stats');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const stats = await response.json();

    // 缓存数据
    cacheManager.cacheUserStats(stats);

    return stats;
  } catch (error) {
    console.error('获取用户统计数据失败:', error);

    // 如果服务器请求失败，先检查是否有缓存的统计数据
    const cachedStats = cacheManager.getCachedUserStats();
    
    // 如果有缓存的统计数据，优先使用缓存数据而不是重新计算
    if (cachedStats) {
      console.log('使用缓存的统计数据:', cachedStats);
      return cachedStats;
    }

    // 基于本地观看记录计算统计数据
    const playRecords = await getAllPlayRecords();
    const records = Object.values(playRecords);

    if (records.length === 0) {
      // 如果没有播放记录且没有缓存数据，返回初始值
      return {
        totalWatchTime: 0,
        totalMovies: 0,
        firstWatchDate: Date.now(),
        lastUpdateTime: Date.now()
      };
    }

    const totalWatchTime = records.reduce((sum, record) => sum + record.play_time, 0);
    const totalMovies = new Set(records.map(r => `${r.title}_${r.source_name}_${r.year}`)).size;
    const firstWatchDate = Math.min(...records.map(r => r.save_time));

    const stats: UserStats = {
      totalWatchTime,
      totalMovies,
      firstWatchDate,
      lastUpdateTime: Date.now()
    };

    // 缓存计算结果
    cacheManager.cacheUserStats(stats);

    return stats;
  }
}

/**
 * 更新用户统计数据
 */
export async function updateUserStats(record: PlayRecord): Promise<void> {
  console.log('=== updateUserStats 开始执行 ===', {
    title: record.title,
    source: record.source_name,
    year: record.year,
    index: record.index,
    playTime: record.play_time,
    totalTime: record.total_time,
    saveTime: new Date(record.save_time).toLocaleString()
  });

  try {
    // 统一使用相同的movieKey格式，确保影片数量统计准确
    const movieKey = `${record.title}_${record.source_name}_${record.year}`;
    console.log('生成的movieKey:', movieKey);

    // 使用包含集数信息的键来缓存每一集的播放进度
    const episodeKey = `${record.source_name}+${record.title}-${record.year}+${record.index}`;
    const lastProgressKey = `last_progress_${episodeKey}`;
    const lastUpdateTimeKey = `last_update_time_${episodeKey}`;

    // 获取上次播放进度和更新时间
    const lastProgress = parseInt(localStorage.getItem(lastProgressKey) || '0');
    const lastUpdateTime = parseInt(localStorage.getItem(lastUpdateTimeKey) || '0');

    // 计算观看时间增量
    let watchTimeIncrement = 0;
    const currentTime = Date.now();
    const timeSinceLastUpdate = currentTime - lastUpdateTime;

    // 放宽更新条件：只要有实际播放进度变化就更新
    // 如果距离上次更新时间太短（小于10秒），且进度没有变化，则跳过更新
    if (timeSinceLastUpdate < 10 * 1000 && Math.abs(record.play_time - lastProgress) < 1) {
      console.log(`跳过统计数据更新: 时间间隔过短 (${Math.floor(timeSinceLastUpdate / 1000)}s) 且进度无变化`);
      return;
    }

    // 改进的观看时间计算逻辑
    if (record.play_time > lastProgress) {
      // 正常播放进度增加
      watchTimeIncrement = record.play_time - lastProgress;

      // 如果进度增加过大（可能是快进），限制增量
      if (watchTimeIncrement > 300) { // 超过5分钟认为是快进
        watchTimeIncrement = Math.min(watchTimeIncrement, Math.floor(timeSinceLastUpdate / 1000) + 60); // 最多比实际时间多1分钟
        console.log(`检测到快进操作: ${record.title} 第${record.index}集 - 进度增加: ${record.play_time - lastProgress}s, 限制增量为: ${watchTimeIncrement}s`);
      }
    } else if (record.play_time < lastProgress) {
      // 进度回退的情况（重新观看、跳转等）
      if (timeSinceLastUpdate > 1 * 60 * 1000) { // 1分钟以上认为是重新开始观看
        watchTimeIncrement = Math.min(record.play_time, 60); // 重新观看最多给60秒增量
        console.log(`检测到重新观看: ${record.title} 第${record.index}集 - 当前进度: ${record.play_time}s, 上次进度: ${lastProgress}s, 时间间隔: ${Math.floor(timeSinceLastUpdate / 1000)}s`);
      } else {
        // 短时间内的回退，可能是快退操作，不给增量
        watchTimeIncrement = 0;
        console.log(`检测到快退操作: ${record.title} 第${record.index}集 - 当前进度: ${record.play_time}s, 上次进度: ${lastProgress}s, 不计入观看时间`);
      }
    } else {
      // 进度相同，可能是暂停后继续，给予少量时间增量
      if (timeSinceLastUpdate > 30 * 1000) { // 30秒以上认为有观看时间
        watchTimeIncrement = Math.min(Math.floor(timeSinceLastUpdate / 1000), 60); // 最多1分钟
        console.log(`检测到暂停后继续: ${record.title} 第${record.index}集 - 进度: ${record.play_time}s, 时间间隔: ${Math.floor(timeSinceLastUpdate / 1000)}s, 使用增量: ${watchTimeIncrement}s`);
      }
    }

    console.log(`观看时间增量计算: ${record.title} 第${record.index}集 - 当前进度: ${record.play_time}s, 上次进度: ${lastProgress}s, 增量: ${watchTimeIncrement}s`);

    // 降低更新阈值：只要有观看时间增量就更新统计数据
    if (watchTimeIncrement > 0) {
      console.log(`发送统计数据更新请求: 增量 ${watchTimeIncrement}s, movieKey: ${movieKey}`);

      try {
        // 发送到服务器更新
        const response = await fetchWithAuth('/api/user/stats', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            watchTime: watchTimeIncrement,
            movieKey: movieKey,
            timestamp: currentTime // 使用当前时间戳而不是record.save_time
          }),
        });

        console.log(`API响应状态: ${response.status}`);

        if (response.ok) {
          const responseData = await response.json();
          console.log(`API响应数据:`, responseData);

          // 更新localStorage中的上次播放进度和更新时间
          localStorage.setItem(lastProgressKey, record.play_time.toString());
          localStorage.setItem(lastUpdateTimeKey, currentTime.toString());
          console.log(`更新缓存: ${lastProgressKey} = ${record.play_time}, ${lastUpdateTimeKey} = ${currentTime}`);

          // 立即更新缓存中的用户统计数据
          const authInfo = getAuthInfoFromBrowserCookie();
          if (authInfo?.username && responseData.userStats) {
            cacheManager.cacheUserStats(responseData.userStats);
            console.log(`更新用户统计数据缓存:`, responseData.userStats);

            // 触发用户统计数据更新事件
            window.dispatchEvent(new CustomEvent('userStatsUpdated', {
              detail: responseData.userStats
            }));
            console.log(`触发userStatsUpdated事件`);
          } else {
            // 如果API没有返回userStats，强制重新获取最新数据
            console.log(`API未返回userStats，强制重新获取`);
            try {
              const latestStats = await getUserStats();
              window.dispatchEvent(new CustomEvent('userStatsUpdated', {
                detail: latestStats
              }));
              console.log(`重新获取并触发userStatsUpdated事件:`, latestStats);
            } catch (error) {
              console.error('重新获取用户统计数据失败:', error);
              // 不清除缓存，避免触发强制同步导致统计数据重置
              // 保留现有缓存数据，确保统计数据的连续性
              console.log('保留现有缓存数据，避免统计数据被重置');
            }
          }

          console.log(`用户统计数据已更新: 增量 ${watchTimeIncrement}s`);
        } else {
          const errorText = await response.text();
          console.error(`更新用户统计数据失败: ${response.status} ${response.statusText}`, errorText);

          // API调用失败时，仍然更新本地进度记录，避免重复计算
          localStorage.setItem(lastProgressKey, record.play_time.toString());
          localStorage.setItem(lastUpdateTimeKey, currentTime.toString());
        }
      } catch (error) {
        console.error('统计数据更新请求异常:', error);
        
        // 即使API请求失败，也要更新本地进度记录，避免重复计算
        localStorage.setItem(lastProgressKey, record.play_time.toString());
        localStorage.setItem(lastUpdateTimeKey, currentTime.toString());
        
        // 不抛出错误，避免影响播放体验
        console.log('统计数据更新失败，但不影响播放功能');
      }
    } else {
      console.log(`无需更新用户统计数据: 增量为 ${watchTimeIncrement}s`);

      // 即使没有增量，也要更新时间戳和进度，避免下次计算错误
      localStorage.setItem(lastProgressKey, record.play_time.toString());
      localStorage.setItem(lastUpdateTimeKey, currentTime.toString());
    }
  } catch (error) {
    console.error('更新用户统计数据失败:', error);
    // 静默失败，不影响用户体验
  }
}

/**
 * 清除用户统计数据
 */
export async function clearUserStats(): Promise<void> {
  try {
    // 从服务器清除
    await fetchWithAuth('/api/user/stats', {
      method: 'DELETE',
    });

    // 清除本地缓存
    const authInfo = getAuthInfoFromBrowserCookie();
    if (authInfo?.username) {
      cacheManager.clearUserCache(authInfo.username);
    }
  } catch (error) {
    console.error('清除用户统计数据失败:', error);
    throw error;
  }
}

/**
 * 基于历史记录重新计算统计数据
 * 用于新增统计功能后，为已有用户初始化统计数据
 */
export async function recalculateUserStatsFromHistory(): Promise<UserStats | null> {
  const authInfo = getAuthInfoFromBrowserCookie();
  if (!authInfo?.username) {
    console.warn('用户未登录，无法重新计算统计数据');
    return null;
  }

  try {
    console.log('开始基于历史记录重新计算统计数据...');

    // 获取所有播放记录
    const playRecords = await getAllPlayRecords();
    const records = Object.values(playRecords);

    if (records.length === 0) {
      console.log('没有播放记录，检查缓存的统计数据');
      const cachedStats = cacheManager.getCachedUserStats();
      if (cachedStats && (cachedStats.totalMovies > 0 || cachedStats.totalWatchTime > 0)) {
        console.log('使用缓存的统计数据，避免重置');
        return cachedStats;
      }
      console.log('没有播放记录且无有效缓存，返回空统计数据');
      return null;
    }

    // 计算统计数据
    let totalWatchTime = 0;
    const watchedMovies = new Set<string>();
    let firstWatchDate = Date.now();

    records.forEach(record => {
      // 累计观看时长
      totalWatchTime += record.play_time || 0;

      // 记录观看的影片 - 使用title+source_name+year作为唯一标识
      const movieKey = `${record.title}_${record.source_name}_${record.year}`;
      watchedMovies.add(movieKey);

      // 找到最早的观看时间
      if (record.save_time < firstWatchDate) {
        firstWatchDate = record.save_time;
      }
    });

    const calculatedStats: UserStats = {
      totalWatchTime: Math.round(totalWatchTime),
      totalMovies: watchedMovies.size,
      firstWatchDate,
      lastUpdateTime: Date.now()
    };

    console.log('计算出的统计数据:', calculatedStats);

    // 尝试从服务器获取现有统计数据
    let existingStats: UserStats | null = null;
    try {
      const response = await fetchWithAuth('/api/user/stats');
      if (response.ok) {
        existingStats = await response.json();
      }
    } catch (error) {
      console.log('获取现有统计数据失败，将创建新的统计数据');
    }

    // 如果服务器没有统计数据，或者计算出的数据更合理，则更新统计数据
    const shouldUpdate = !existingStats ||
      existingStats.totalWatchTime === 0 ||
      existingStats.totalMovies === 0 ||
      calculatedStats.totalWatchTime > existingStats.totalWatchTime ||
      calculatedStats.totalMovies > existingStats.totalMovies;

    if (shouldUpdate) {
      console.log('更新统计数据到服务器...');

      // 为了更新统计数据，我们需要发送一个虚拟的更新请求
      // 使用最后一个播放记录的信息
      const lastRecord = records.sort((a, b) => b.save_time - a.save_time)[0];

      // 构建所有观看过的影片键
      const allMovieKeys = Array.from(watchedMovies).join(',');

      const response = await fetchWithAuth('/api/user/stats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          watchTime: calculatedStats.totalWatchTime,
          movieKey: allMovieKeys, // 传递所有影片键
          timestamp: calculatedStats.firstWatchDate,
          isRecalculation: true // 标记这是重新计算
        }),
      });

      if (response.ok) {
        const result = await response.json();
        const finalStats = result.userStats || calculatedStats;

        // 更新本地缓存
        cacheManager.cacheUserStats(finalStats);

        // 触发统计数据更新事件
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('userStatsUpdated', { detail: finalStats }));
        }

        console.log('统计数据重新计算完成:', finalStats);
        return finalStats;
      } else {
        console.error('更新统计数据到服务器失败:', response.status);
        // 即使服务器更新失败，也返回计算出的数据
        return calculatedStats;
      }
    } else {
      console.log('现有统计数据已经是最新的，无需更新');
      return existingStats;
    }
  } catch (error) {
    console.error('重新计算统计数据失败:', error);
    return null;
  }
}

/**
 * 获取缓存状态信息
 * 用于调试和监控缓存健康状态
 */
export function getCacheStatus(): {
  hasPlayRecords: boolean;
  hasFavorites: boolean;
  hasSearchHistory: boolean;
  hasSkipConfigs: boolean;
  username: string | null;
} {
  if (STORAGE_TYPE === 'localstorage') {
    return {
      hasPlayRecords: false,
      hasFavorites: false,
      hasSearchHistory: false,
      hasSkipConfigs: false,
      username: null,
    };
  }

  const authInfo = getAuthInfoFromBrowserCookie();
  return {
    hasPlayRecords: !!cacheManager.getCachedPlayRecords(),
    hasFavorites: !!cacheManager.getCachedFavorites(),
    hasSearchHistory: !!cacheManager.getCachedSearchHistory(),
    hasSkipConfigs: !!cacheManager.getCachedSkipConfigs(),
    username: authInfo?.username || null,
  };
}

// ---------------- React Hook 辅助类型 ----------------

export type CacheUpdateEvent =
  | 'playRecordsUpdated'
  | 'favoritesUpdated'
  | 'searchHistoryUpdated'
  | 'skipConfigsUpdated'
  | 'userStatsUpdated';

/**
 * 用于 React 组件监听数据更新的事件监听器
 * 使用方法：
 *
 * useEffect(() => {
 *   const unsubscribe = subscribeToDataUpdates('playRecordsUpdated', (data) => {
 *     setPlayRecords(data);
 *   });
 *   return unsubscribe;
 * }, []);
 */
export function subscribeToDataUpdates<T>(
  eventType: CacheUpdateEvent,
  callback: (data: T) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => { };
  }

  const handleUpdate = (event: CustomEvent) => {
    callback(event.detail);
  };

  window.addEventListener(eventType, handleUpdate as EventListener);

  return () => {
    window.removeEventListener(eventType, handleUpdate as EventListener);
  };
}
