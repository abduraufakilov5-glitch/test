# Установка обновления «Магазин»

## ШАГ 1 — SQL (один раз)
В Supabase → SQL Editor откройте `supabase-store-migration.sql`, вставьте файл целиком и нажмите Run. Этот migration выполняется поверх уже существующей debt-схемы и не удаляет `clients`/`transactions`.

## ШАГ 2 — GitHub
Замените файлы сайта файлами из готового ZIP. `supabase.js` уже содержит текущие Project URL и publishable key из исходного проекта — service_role не добавлялся.

## ШАГ 3 — GitHub Pages
Дождитесь нового deploy. Service Worker имеет новый CACHE_NAME `magazin-shell-v4-20260803`, поэтому старая оболочка PWA будет заменена.

## ШАГ 4 — Проверка
Войдите, затем проверьте: быструю продажу; товар + закупку + изменение остатка; расход; продажу в долг; оплату старого долга; аналитику; CSV; выход/повторный вход; standalone PWA на iPhone.

Важно: SQL migration нужен только один раз на Supabase project. Повторно вручную пересоздавать старые debt-таблицы не нужно.
