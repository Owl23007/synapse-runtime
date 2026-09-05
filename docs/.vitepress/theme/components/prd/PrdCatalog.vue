<script setup lang="ts">
import { computed, ref } from "vue";
import { formatPrd, type PrdStatus, type PrdSummary } from "../../utils/prd-formatter";

type CatalogTab = "active" | "archived" | "all";

const modules = import.meta.glob<string>("/prd/**/*.md", {
  eager: true,
  import: "default",
  query: "?raw"
}) as Record<string, string>;

const statusLabels: Record<PrdStatus, string> = {
  wip: "规划中",
  next: "下一步计划",
  "in-progress": "进行中",
  completed: "已完成",
  archived: "已归档"
};

const tabs: Array<{ value: CatalogTab; label: string }> = [
  { value: "active", label: "活动 PRD" },
  { value: "archived", label: "已归档" },
  { value: "all", label: "全部文档" }
];

const query = ref("");
const selectedTab = ref<CatalogTab>("active");
const selectedStatus = ref<PrdStatus | "all">("all");

const prds = computed(() =>
  Object.entries(modules)
    .filter(
      ([path]) => !path.endsWith("/index.md") && !path.endsWith("/archive/README.md") && !path.includes("/templates/")
    )
    .map(([path, source]) => formatPrd(path, source))
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"))
);

const visiblePrds = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase("zh-CN");

  return prds.value.filter((prd) => {
    const isArchived = prd.status === "archived";
    const matchesTab = selectedTab.value === "all" || (selectedTab.value === "archived" ? isArchived : !isArchived);
    const matchesStatus = selectedStatus.value === "all" || prd.status === selectedStatus.value;
    const matchesQuery = normalizedQuery === "" || prd.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery);

    return matchesTab && matchesStatus && matchesQuery;
  });
});

const tabCounts = computed(() => ({
  active: prds.value.filter((prd) => prd.status !== "archived").length,
  archived: prds.value.filter((prd) => prd.status === "archived").length,
  all: prds.value.length
}));

function documentLink(prd: PrdSummary): string {
  return prd.path.replace(/\.md$/, "");
}

function resetStatusForTab(tab: CatalogTab): void {
  selectedTab.value = tab;
  selectedStatus.value = "all";
}

function clearSearch(): void {
  query.value = "";
}
</script>

<template>
  <section class="prd-catalog" aria-labelledby="prd-catalog-title">
    <div class="prd-catalog__heading">
      <div>
        <p class="prd-catalog__eyebrow">DOCUMENT DIRECTORY</p>
        <h2 id="prd-catalog-title">PRD 文档目录</h2>
      </div>
      <p>{{ visiblePrds.length }} / {{ prds.length }} 份文档</p>
    </div>

    <div class="prd-catalog__tabs" role="tablist" aria-label="PRD 文档范围">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        type="button"
        role="tab"
        :aria-selected="selectedTab === tab.value"
        :class="{ 'is-active': selectedTab === tab.value }"
        @click="resetStatusForTab(tab.value)"
      >
        {{ tab.label }} <span>{{ tabCounts[tab.value] }}</span>
      </button>
    </div>

    <div class="prd-catalog__toolbar">
      <label class="prd-catalog__search">
        <span class="sr-only">搜索 PRD</span>
        <span aria-hidden="true">⌕</span>
        <input v-model="query" type="search" placeholder="搜索标题" />
        <button v-if="query" type="button" aria-label="清除搜索" @click="clearSearch">×</button>
      </label>
      <label class="prd-catalog__filter">
        <span>状态</span>
        <select v-model="selectedStatus">
          <option value="all">全部</option>
          <option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option>
        </select>
      </label>
    </div>

    <ul v-if="visiblePrds.length" class="prd-catalog__list">
      <li v-for="prd in visiblePrds" :key="prd.path" class="prd-catalog__item">
        <a :href="documentLink(prd)">
          <span class="prd-catalog__title">{{ prd.title }}</span>
          <span class="prd-catalog__meta">
            <span class="prd-catalog__status">{{ statusLabels[prd.status] }}</span>
            <span v-if="prd.progress === null">待标注进度</span>
            <span v-else>{{ prd.progress }}% · {{ prd.completedTasks }}/{{ prd.totalTasks }} 项任务</span>
          </span>
        </a>
      </li>
    </ul>
    <p v-else class="prd-catalog__empty">没有匹配的 PRD 文档</p>
  </section>
</template>
