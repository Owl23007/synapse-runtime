<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { formatPrd, type PrdStatus } from "../../utils/prd-formatter";

const PAGE_SIZE = 4;
const modules = import.meta.glob("/prd/**/*.md", {
  eager: true,
  import: "default",
  query: "?raw"
}) as Record<string, string>;

const stages: Array<{ status: PrdStatus; label: string; caption: string }> = [
  { status: "wip", label: "规划中", caption: "WIP" },
  { status: "next", label: "下一步计划", caption: "已排队" },
  { status: "in-progress", label: "进行中", caption: "正在交付" },
  { status: "completed", label: "完成", caption: "本迭代" },
  { status: "archived", label: "归档", caption: "历史记录" }
];

const query = ref("");
const selectedStatus = ref<PrdStatus | "all">("all");
const pageByStatus = reactive<Record<PrdStatus, number>>({
  wip: 1,
  next: 1,
  "in-progress": 1,
  completed: 1,
  archived: 1
});

const prds = computed(() =>
  Object.entries(modules)
    .filter(([path]) => !path.endsWith("/index.md") && !path.endsWith("/archive/README.md"))
    .map(([path, source]) => formatPrd(path, source))
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"))
);

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase("zh-CN"));

const columns = computed(() =>
  stages
    .filter((stage) => selectedStatus.value === "all" || stage.status === selectedStatus.value)
    .map((stage) => {
      const matchedPrds = prds.value.filter(
        (prd) =>
          prd.status === stage.status &&
          (normalizedQuery.value === "" || prd.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery.value))
      );
      const totalPages = Math.max(1, Math.ceil(matchedPrds.length / PAGE_SIZE));
      const currentPage = Math.min(pageByStatus[stage.status], totalPages);

      return Object.assign({}, stage, {
        total: matchedPrds.length,
        currentPage,
        totalPages,
        prds: matchedPrds.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
      });
    })
);

const matchedCount = computed(() => columns.value.reduce((total, column) => total + column.total, 0));

/** 搜索或切换阶段后从每列的第一页重新开始展示 */
function resetPages(): void {
  for (const stage of stages) pageByStatus[stage.status] = 1;
}

/** 切换指定阶段的分页 */
function setPage(status: PrdStatus, page: number): void {
  pageByStatus[status] = page;
}
</script>

<template>
  <section class="roadmap-board" aria-labelledby="roadmap-board-title">
    <div class="roadmap-board__heading">
      <div>
        <p class="roadmap-board__eyebrow">PRD 生命周期</p>
        <h2 id="roadmap-board-title">当前路线图</h2>
      </div>
      <p>{{ prds.length }} 份 PRD</p>
    </div>

    <div class="roadmap-board__toolbar">
      <label class="roadmap-board__search">
        <span class="sr-only">搜索 PRD</span>
        <span aria-hidden="true">⌕</span>
        <input v-model="query" type="search" placeholder="搜索 PRD 名称" @input="resetPages" />
        <button
          v-if="query"
          type="button"
          aria-label="清除搜索"
          @click="
            query = '';
            resetPages();
          "
        >
          ×
        </button>
      </label>
      <label class="roadmap-board__filter">
        <span>阶段</span>
        <select v-model="selectedStatus" @change="resetPages">
          <option value="all">全部阶段</option>
          <option v-for="stage in stages" :key="stage.status" :value="stage.status">{{ stage.label }}</option>
        </select>
      </label>
      <p aria-live="polite">显示 {{ matchedCount }} / {{ prds.length }} 份</p>
    </div>

    <div class="roadmap-board__flow" aria-label="PRD 状态流转">
      <span v-for="(stage, index) in stages" :key="stage.status">
        {{ stage.label }}<b v-if="index < stages.length - 1" aria-hidden="true">→</b>
      </span>
    </div>

    <div class="roadmap-board__columns" :class="`roadmap-board__columns--${columns.length}`">
      <section
        v-for="column in columns"
        :key="column.status"
        class="roadmap-board__column"
        :class="`roadmap-board__column--${column.status}`"
      >
        <header>
          <div>
            <h3>{{ column.label }}</h3>
            <p>{{ column.caption }}</p>
          </div>
          <strong>{{ column.total }}</strong>
        </header>
        <ul>
          <li v-for="prd in column.prds" :key="prd.path">
            <a :href="prd.path.replace(/\.md$/, '')">{{ prd.title }}</a>
            <p v-if="prd.progress === null">待标注任务</p>
            <p v-else>{{ prd.progress }}% · {{ prd.completedTasks }}/{{ prd.totalTasks }} 项任务</p>
          </li>
          <li v-if="column.total === 0" class="roadmap-board__empty">暂无匹配的 PRD</li>
        </ul>
        <nav v-if="column.totalPages > 1" class="roadmap-board__pagination" :aria-label="`${column.label}分页`">
          <button
            type="button"
            :disabled="column.currentPage === 1"
            @click="setPage(column.status, column.currentPage - 1)"
          >
            上一页
          </button>
          <span>{{ column.currentPage }} / {{ column.totalPages }}</span>
          <button
            type="button"
            :disabled="column.currentPage === column.totalPages"
            @click="setPage(column.status, column.currentPage + 1)"
          >
            下一页
          </button>
        </nav>
      </section>
    </div>
  </section>
</template>
