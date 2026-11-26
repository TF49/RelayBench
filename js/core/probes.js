// 稳定性提示词 + 质量题（本地按标准答案判分）。

const TOPICS = [
  '光合作用', '区块链', 'TCP 三次握手', '黑洞', '通货膨胀', '机器学习中的过拟合', '量子纠缠', '复利',
  'HTTP 缓存', '板块构造', '疫苗原理', '数据库索引', '蝴蝶效应', '摩尔定律', '潮汐成因', '哈希表',
  '温室效应', '供需关系', '递归', '彩虹形成', 'DNS 解析', '免疫系统', '负载均衡', '相对论',
];

const TEMPLATES = [
  (t) => `用三到四句话向中学生解释「${t}」，不要使用列表。`,
  (t) => `请简要介绍「${t}」的基本原理，控制在 120 字左右。`,
  (t) => `用一个生活中的比喻说明「${t}」，100 字以内。`,
  (t) => `In about 80 words, explain "${t}" to a beginner.`,
];

/** 第 i 个稳定性请求的提示词。带随机编号以避开缓存。 */
export function stabilityPrompt(i, rand = Math.random) {
  const topic = TOPICS[Math.floor(rand() * TOPICS.length)];
  const tpl = TEMPLATES[i % TEMPLATES.length];
  const nonce = Math.floor(rand() * 1e6).toString(36);
  return `${tpl(topic)}（编号 ${nonce}，无需提及编号）`;
}

function stripFences(text) {
  const s = String(text || '').trim();
  const m = /^```[\w-]*\s*\n?([\s\S]*?)\n?```$/.exec(s);
  return m ? m[1].trim() : s;
}

function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export const QUALITY_PROBES = [
  {
    id: 'arith',
    name: '算术',
    prompt: '计算 37 × 48 + 129 的结果。只输出最终数字，不要任何解释。',
    expect: '1905',
    check(text) {
      const t = stripThink(text).replace(/[,，\s]/g, '');
      const nums = t.match(/-?\d+(\.\d+)?/g) || [];
      const pass = nums.length > 0 && nums[nums.length - 1] === '1905';
      const strict = t === '1905';
      return { pass, detail: pass ? (strict ? '答案正确' : '答案正确，但带了多余内容') : `答案错误（期望 1905）` };
    },
  },
  {
    id: 'format',
    name: '指令遵循',
    prompt: '把这三个单词全部转为大写，用英文逗号分隔，按原顺序输出：apple banana cherry。除此之外不要输出任何内容。',
    expect: 'APPLE,BANANA,CHERRY',
    check(text) {
      const t = stripThink(text).replace(/\s+/g, '');
      const pass = t === 'APPLE,BANANA,CHERRY' || t === 'APPLE,BANANA,CHERRY.';
      return { pass, detail: pass ? '格式完全正确' : '未严格按格式输出' };
    },
  },
  {
    id: 'json',
    name: 'JSON 输出',
    prompt: '输出一个 JSON 对象，包含三个字段：name 为字符串 "relay"，count 为数字 3，tags 为数组 ["a","b"]。只输出 JSON 本身，不要代码块，不要解释。',
    expect: '{"name":"relay","count":3,"tags":["a","b"]}',
    check(text) {
      const raw = stripThink(text);
      const fenced = raw.trim().startsWith('```');
      let obj;
      try {
        obj = JSON.parse(stripFences(raw));
      } catch {
        return { pass: false, detail: '不是合法 JSON' };
      }
      const ok = obj && obj.name === 'relay' && obj.count === 3
        && Array.isArray(obj.tags) && obj.tags.length === 2 && obj.tags[0] === 'a' && obj.tags[1] === 'b';
      if (!ok) return { pass: false, detail: 'JSON 合法但字段不符' };
      return { pass: true, detail: fenced ? '字段正确，但违反要求加了代码块' : '完全正确' };
    },
  },
  {
    id: 'reason',
    name: '简单推理',
    prompt: '篮子里有 5 个苹果，拿走 2 个，又放进 3 个，然后吃掉剩下苹果的一半。篮子里还剩几个苹果？只回答一个数字。',
    expect: '3',
    check(text) {
      const t = stripThink(text);
      const nums = t.match(/\d+/g) || [];
      const last = nums[nums.length - 1];
      const pass = last === '3' || /^三个?$/.test(t.trim());
      return { pass, detail: pass ? '答案正确' : '答案错误（期望 3）' };
    },
  },
];

export function getProbe(id) {
  return QUALITY_PROBES.find((p) => p.id === id);
}
