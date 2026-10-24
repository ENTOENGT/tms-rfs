'use client';
import { Suspense } from 'react';
import JobList from '@/components/JobList';
export default function Requests() { return <Suspense><JobList mode="requests" /></Suspense>; }
