'use client';
import { Suspense } from 'react';
import JobList from '@/components/JobList';
export default function Jobs() { return <Suspense><JobList mode="jobs" /></Suspense>; }
